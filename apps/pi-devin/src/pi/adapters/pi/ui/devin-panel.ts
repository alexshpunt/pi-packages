import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Cause, Effect, Exit } from "effect";
import type { DevinError } from "../../../../core/errors.ts";
import type { DevinPreferences } from "../../../features/settings/types.ts";
import type { UsageLine } from "../../../features/usage/types.ts";
import type { PickerTheme } from "./fusion-picker.ts";

export const PREFERENCE_ITEMS: readonly { key: keyof DevinPreferences; label: string; detail: string }[] = [
  { key: "recommendedOnly", label: "Recommended models only", detail: "/model shows only models with a recommended variant and Devin Fusion" },
  { key: "showUsageStatus", label: "Usage in status line", detail: "shows quota and session tokens in the footer" },
];
const HELP = "↑↓ move · space/↵ toggle · esc close";

export interface DevinPanelOptions {
  theme: PickerTheme;
  report: () => UsageLine[];
  preferences: DevinPreferences;
  /** Saves and applies on every toggle. On failure, shows a notice and reverts to the previous value. */
  onChange: (next: DevinPreferences) => Effect.Effect<void, DevinError>;
  requestRender: () => void;
  done: () => void;
}

/** TUI screen for `/devin`. Shows usage details together with the display setting toggles. */
export class DevinPanel {
  private cursor = 0;
  private preferences: DevinPreferences;
  private notice: string | undefined;
  private isSaving = false;
  private cached: { width: number; lines: string[] } | undefined;
  private readonly options: DevinPanelOptions;

  constructor(options: DevinPanelOptions) {
    this.options = options;
    this.preferences = { ...options.preferences };
  }

  invalidate(): void { this.cached = undefined; }

  private changed(): void { this.invalidate(); this.options.requestRender(); }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.options.done();
    if (matchesKey(data, "up")) { this.cursor = (this.cursor + PREFERENCE_ITEMS.length - 1) % PREFERENCE_ITEMS.length; return this.changed(); }
    if (matchesKey(data, "down")) { this.cursor = (this.cursor + 1) % PREFERENCE_ITEMS.length; return this.changed(); }
    if ((matchesKey(data, "space") || matchesKey(data, "enter")) && !this.isSaving) void this.toggle();
  }

  private async toggle(): Promise<void> {
    const key = PREFERENCE_ITEMS[this.cursor].key, previous = this.preferences;
    this.preferences = { ...previous, [key]: !previous[key] };
    this.isSaving = true; this.notice = undefined; this.changed();
    const exit = await Effect.runPromiseExit(this.options.onChange(this.preferences));
    if (Exit.isFailure(exit)) {
      this.preferences = previous;
      // A thrown host error is reported with its own message, like a failed save.
      const error = Cause.squash(exit.cause);
      this.notice = `Could not save: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.isSaving = false; this.changed();
  }

  render(width: number): string[] {
    if (this.cached?.width === width) return this.cached.lines;
    const { theme } = this.options;
    const lines = [theme.fg("accent", theme.bold("Devin")) + theme.fg("muted", " · usage and display settings"), ""];
    for (const line of this.options.report()) lines.push(theme.fg(line.isHeading ? "accent" : line.tone ?? "muted", line.text));
    lines.push("", theme.fg("accent", theme.bold("Settings")));
    PREFERENCE_ITEMS.forEach((item, index) => {
      const isSelected = index === this.cursor;
      const row = `${isSelected ? "›" : " "} [${this.preferences[item.key] ? "x" : " "}] ${item.label}`;
      lines.push((isSelected ? theme.fg("accent", theme.bold(row)) : row) + theme.fg("dim", ` — ${item.detail}`));
    });
    lines.push("", this.notice ? theme.fg("warning", this.notice) : theme.fg("dim", this.isSaving ? "Saving…" : HELP));
    const result = lines.map((line) => truncateToWidth(line, width));
    this.cached = { width, lines: result };
    return result;
  }
}
