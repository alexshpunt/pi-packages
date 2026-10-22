import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface PanelMessage {
  readonly text: string;
  readonly isError: boolean;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Text wrapped to `width` with a one-column left margin, as Pi's own panels indent their text. */
export function paragraph(text: string, width: number): string[] {
  const inner = Math.max(1, width - 1);
  return text.split("\n").flatMap((line) => wrapTextWithAnsi(line, inner).map((wrapped) => ` ${wrapped}`));
}

export function title(theme: Theme, text: string, width: number): string {
  return truncateToWidth(` ${theme.fg("accent", theme.bold(text))}`, width);
}

export function hint(theme: Theme, text: string, width: number): string {
  return truncateToWidth(theme.fg("dim", `  ${text}`), width);
}

export function messageLines(theme: Theme, message: PanelMessage | undefined, width: number): string[] {
  if (!message) return [];
  return paragraph(theme.fg(message.isError ? "error" : "success", message.text), width);
}
