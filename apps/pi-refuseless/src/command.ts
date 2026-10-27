import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getSettingsListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, SettingsList, Text } from "@earendil-works/pi-tui";
import { type Credits, formatUsd, readCredits } from "./credits.ts";
import type { CreditsStatus } from "./credits-status.ts";

export const COMMAND_NAME = "pi-refuseless";
const NO_KEY = "No Refuseless API key. Run /login and choose Refuseless.";
const STATUS_ITEM = "creditsStatus";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The balance as aligned `label  value` lines. */
function creditLines(credits: Credits): string[] {
  const rows: [string, string][] = [
    ["Available", formatUsd(credits.available)],
    ["Balance", formatUsd(credits.balance)],
    ["Reserved", formatUsd(credits.reserved)],
    ["Key limit", credits.keyLimit === null ? "none" : formatUsd(credits.keyLimit)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}

/**
 * `/pi-refuseless` in interactive Pi: the balance, read once when the panel opens, and the status line switch.
 * Closing the panel cancels a read still in progress.
 */
class RefuselessPanel implements Component {
  private readonly ctx: ExtensionCommandContext;
  private readonly status: CreditsStatus;
  private readonly theme: Theme;
  private readonly requestRender: () => void;
  private readonly border: DynamicBorder;
  private readonly list: SettingsList;
  private readonly request = new AbortController();
  private credits: { lines: string[] } | { error: string } | undefined;
  private saveError: string | undefined;

  constructor(
    ctx: ExtensionCommandContext,
    status: CreditsStatus,
    theme: Theme,
    requestRender: () => void,
    close: () => void,
  ) {
    this.ctx = ctx;
    this.status = status;
    this.theme = theme;
    this.requestRender = requestRender;
    this.border = new DynamicBorder((text) => theme.fg("accent", text));
    this.list = new SettingsList(
      [
        {
          id: STATUS_ITEM,
          label: "Credits in status line",
          currentValue: status.isEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
      ],
      1,
      getSettingsListTheme(),
      (_id, value) => {
        this.saveError = this.status.setEnabled(value === "on", this.ctx);
      },
      close,
    );
    void this.load();
  }

  private async load() {
    let credits: RefuselessPanel["credits"];
    try {
      const read = await readCredits(this.ctx, this.request.signal);
      credits = read ? { lines: creditLines(read) } : { error: NO_KEY };
    } catch (error) {
      credits = { error: errorText(error) };
    }
    if (this.request.signal.aborted) return;
    this.credits = credits;
    this.requestRender();
  }

  handleInput(data: string) {
    this.list.handleInput(data);
    this.requestRender();
  }

  render(width: number): string[] {
    const { theme } = this;
    const text = (content: string) => new Text(content, 1, 0).render(width);
    const credits =
      this.credits === undefined
        ? theme.fg("muted", "Checking credits…")
        : "error" in this.credits
          ? theme.fg("error", this.credits.error)
          : this.credits.lines.join("\n");
    return [
      ...this.border.render(width),
      ...text(theme.fg("accent", theme.bold("Refuseless credits"))),
      "",
      ...text(credits),
      "",
      ...this.list.render(width),
      ...(this.saveError ? ["", ...text(theme.fg("error", this.saveError))] : []),
      ...this.border.render(width),
    ];
  }

  invalidate() {
    this.border.invalidate();
    this.list.invalidate();
  }

  dispose() {
    this.request.abort();
  }
}

/** Outside interactive Pi: the balance as a notification, or on stderr without a UI. */
async function reportCredits(ctx: ExtensionCommandContext) {
  let message: string;
  let level: "info" | "error" = "error";
  try {
    const credits = await readCredits(ctx);
    message = credits ? ["Refuseless credits", ...creditLines(credits).map((line) => `  ${line}`)].join("\n") : NO_KEY;
    if (credits) level = "info";
  } catch (error) {
    message = errorText(error);
  }
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else process.stderr.write(`${message}\n`);
}

export function registerRefuselessCommand(pi: ExtensionAPI, status: CreditsStatus) {
  pi.registerCommand(COMMAND_NAME, {
    description: "Refuseless credit balance and the status line setting",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return reportCredits(ctx);
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new RefuselessPanel(
            ctx,
            status,
            theme,
            () => tui.requestRender(),
            () => done(),
          ),
      );
    },
  });
}
