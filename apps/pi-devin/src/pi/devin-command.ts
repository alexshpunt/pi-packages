import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DevinPanel, PREFERENCE_ITEMS } from "./devin-panel.ts";
import type { DevinPreferences, DevinSettings } from "./devin-settings.ts";
import type { DevinProvider } from "./provider.ts";
import { sessionUsage, usageReport, usageStatusText } from "./usage.ts";

export const DEVIN_COMMAND_NAME = "devin";
/** The only status key this package uses. */
export const USAGE_STATUS_KEY = "devin-usage";
const USAGE = "Usage: /devin, /devin recommended on|off, /devin status on|off";
const ARGUMENT_KEYS: Readonly<Record<string, keyof DevinPreferences>> = { recommended: "recommendedOnly", status: "showUsageStatus" };

/** The status is used in the TUI only. Turning the toggle off clears only this package's key. Values come only from the last account status and session records. */
export function updateUsageStatus(ctx: ExtensionContext, provider: DevinProvider, settings: DevinSettings): void {
  if (ctx.mode !== "tui") return;
  const text = settings.read().showUsageStatus
    ? usageStatusText(provider.getAccountUsage(), sessionUsage(ctx.sessionManager.getBranch()), (tone, segment) => ctx.ui.theme.fg(tone, segment)) : undefined;
  ctx.ui.setStatus(USAGE_STATUS_KEY, text);
}

const onOff = (value: boolean) => value ? "on" : "off";

/**
 * `/devin` shows usage details and display settings. Settings are saved globally and applied immediately.
 * The TUI gets a dedicated screen; other modes use arguments and notifications.
 */
export function registerDevinCommand(pi: ExtensionAPI, provider: DevinProvider, settings: DevinSettings, options: { now?: () => number } = {}): void {
  const now = options.now ?? Date.now;
  const apply = async (ctx: ExtensionCommandContext, next: DevinPreferences) => {
    const previous = settings.read();
    // Only write failures are thrown to the caller. A list refresh failure after saving is reported as a warning so the screen and the saved value stay in sync.
    settings.write(next);
    if (previous.recommendedOnly !== next.recommendedOnly) {
      provider.rebuildModels();
      // Pi keeps model and availability snapshots. Rebuild them without network so `/model` and RPC lists update immediately.
      try {
        await ctx.modelRegistry.refresh({ providers: ["devin"], allowNetwork: false });
      } catch (error) {
        ctx.ui.notify(`Settings were saved, but the model list could not be rebuilt: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      const model = ctx.model;
      if (model?.provider === "devin" && !provider.getModels().some((item) => item.id === model.id)) {
        ctx.ui.notify(`The current model ${model.name} is now hidden from the list but stays in use for this session. To restore it when reopening the session, pick a model from the list.`, "warning");
      }
    }
    updateUsageStatus(ctx, provider, settings);
  };
  pi.registerCommand(DEVIN_COMMAND_NAME, {
    description: "Show Devin usage and change display settings (recommended models only, usage in the status line); saved globally",
    handler: async (args, ctx) => {
      const report = () => usageReport(provider.getAccountUsage(), sessionUsage(ctx.sessionManager.getBranch()), provider.lifecycle.budget(), now());
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (tokens.length) {
        const key = ARGUMENT_KEYS[tokens[0]];
        if (tokens.length !== 2 || !key || (tokens[1] !== "on" && tokens[1] !== "off")) {
          ctx.ui.notify(`Unknown argument. ${USAGE}`, "error");
          return;
        }
        const value = tokens[1] === "on";
        await apply(ctx, { ...settings.read(), [key]: value });
        ctx.ui.notify(`${PREFERENCE_ITEMS.find((item) => item.key === key)!.label}: ${onOff(value)} (saved globally)`, "info");
        return;
      }
      if (ctx.mode === "tui") {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new DevinPanel({
          theme, report, preferences: settings.read(), onChange: (next) => apply(ctx, next),
          requestRender: () => tui.requestRender(), done: () => done(),
        }));
        return;
      }
      const preferences = settings.read();
      const summary = PREFERENCE_ITEMS.map((item) => `${item.label} ${onOff(preferences[item.key])}`).join(" · ");
      ctx.ui.notify([...report().map((line) => line.text), `Settings: ${summary}`, USAGE].join("\n"), "info");
    },
  });
}
