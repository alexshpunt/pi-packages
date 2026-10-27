import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MaskPreview } from "../masking-session.js";
import { hint, paragraph, title } from "./common.js";

export interface TryPanelOptions {
  readonly theme: Theme;
  preview(text: string): MaskPreview;
  requestRender(): void;
  onClose(): void;
}

/** Mask one typed line with the saved settings. Nothing typed here is stored or sent. */
export class TryPanel implements Component, Focusable {
  readonly #options: TryPanelOptions;
  readonly #input: Input;
  #result: { readonly text: string; readonly preview: MaskPreview } | undefined;
  #isFocused = false;

  constructor(options: TryPanelOptions) {
    this.#options = options;
    this.#input = new Input({
      placeholder: "Type or paste a line, then press Enter",
      placeholderStyle: (text) => options.theme.fg("dim", text),
    });
    this.#input.onSubmit = (text) => {
      this.#result = text ? { text, preview: options.preview(text) } : undefined;
      options.requestRender();
    };
    this.#input.onEscape = () => options.onClose();
  }

  get focused(): boolean {
    return this.#isFocused;
  }

  set focused(value: boolean) {
    this.#isFocused = value;
    this.#input.focused = value;
  }

  handleInput(data: string): void {
    this.#input.handleInput(data);
    this.#options.requestRender();
  }

  #renderResult(width: number): string[] {
    const { theme } = this.#options;
    const result = this.#result;
    if (!result) return [];
    if (result.preview.masked === result.text)
      return ["", ...paragraph(theme.fg("muted", "Nothing was masked."), width)];
    const diff = renderDiff(`-1 ${result.text.replace(/\n/g, " ")}\n+1 ${result.preview.masked.replace(/\n/g, " ")}`);
    return [
      "",
      ...diff.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width))),
      ...paragraph(theme.fg("muted", `Rules: ${result.preview.ruleIds.join(", ")}`), width),
    ];
  }

  render(width: number): string[] {
    const { theme } = this.#options;
    return [
      title(theme, "Try masking", width),
      ...paragraph(
        theme.fg("muted", "Masks the line with the saved settings. Nothing typed here is stored or sent to the model."),
        width,
      ),
      "",
      ...this.#input.render(width),
      ...this.#renderResult(width),
      "",
      hint(theme, "Enter to mask · Esc to go back", width),
    ];
  }

  invalidate(): void {
    this.#input.invalidate();
  }
}
