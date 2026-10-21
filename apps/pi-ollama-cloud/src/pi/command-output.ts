import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Keep command results visible without writing to JSON mode's stdout. */
export function reportCommandResult(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else process.stderr.write(`${message}\n`);
}
