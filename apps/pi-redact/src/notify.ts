import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Error presentation shared by terminal panels and host notifications. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Never throws: a failing notification must not stop a handler from returning its masked result. */
export function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    // Without a UI, Pi keeps stdout for its own output and moves other writes to stderr.
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else process.stderr.write(`${message}\n`);
  } catch {}
}
