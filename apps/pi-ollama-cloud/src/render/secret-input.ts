import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, truncateToWidth } from "@earendil-works/pi-tui";

export interface SecretInputOptions {
  /** Leading characters rendered as typed so the key can be recognized; the rest is masked. */
  visiblePrefixLength?: number;
}

/**
 * Single-line input for API keys and key references. Editing and paste handling
 * come from pi-tui's Input, but only the configured prefix and a mask are ever
 * rendered, so the full value cannot appear on screen or in terminal scrollback.
 */
export class SecretInput implements Component, Focusable {
  private readonly input = new Input();
  private readonly title: string;
  private readonly theme: Theme;
  private readonly visiblePrefixLength: number;
  private isFocused = false;

  constructor(
    title: string,
    theme: Theme,
    done: (value: string | undefined) => void,
    options: SecretInputOptions = {},
  ) {
    this.title = title;
    this.theme = theme;
    this.visiblePrefixLength = Math.max(0, options.visiblePrefixLength ?? 0);
    this.input.onSubmit = (value) => done(value);
    this.input.onEscape = () => done(undefined);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    const value = this.input.getValue();
    const prefix = value.slice(0, this.visiblePrefixLength);
    const masked = "•".repeat(Math.max(value.length - prefix.length, 0));
    const shown = value.length === 0 ? this.theme.fg("dim", "(empty)") : `${prefix}${masked}`;
    const visibility =
      this.visiblePrefixLength > 0
        ? `Only the first ${this.visiblePrefixLength} characters are shown.`
        : "The value is never displayed.";
    return [
      truncateToWidth(this.theme.fg("accent", this.title), width),
      truncateToWidth(`> ${shown}`, width, ""),
      truncateToWidth(this.theme.fg("dim", `Enter saves, Esc cancels. ${visibility}`), width),
    ];
  }

  invalidate(): void {
    this.input.invalidate();
  }
}
