import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MaskingStatus } from "../masking-session.js";
import { notify } from "../notify.js";
import { emptyStats, type SessionStats } from "../status.js";

const STATUS_KEY = "pi-redact";

/** Per-session host diagnostics: counters, duplicate warnings, and the status-bar projection. */
export function createSessionFeedback() {
  let stats = emptyStats();
  const reported = new Set<string>();

  function report(ctx: ExtensionContext, message: string, level: "warning" | "error"): void {
    if (reported.has(message)) return;
    reported.add(message);
    notify(ctx, `pi-redact: ${message}`, level);
  }

  return {
    reset() {
      stats = emptyStats();
      reported.clear();
    },
    snapshot: (): SessionStats => ({ ...stats }),
    count(key: keyof SessionStats, amount = 1) {
      stats[key] += amount;
    },
    report,
    withheld(ctx: ExtensionContext, count: number, where: string) {
      if (count === 0) return;
      stats.withheld += count;
      report(ctx, `masking failed for ${where}; the affected content was withheld instead of sent`, "error");
    },
    statusBar(ctx: ExtensionContext, status: Pick<MaskingStatus, "isEnabled" | "sessionChoice">) {
      if (!ctx.hasUI) return;
      try {
        const text = status.sessionChoice === undefined ? "redact off" : "redact off (this session)";
        ctx.ui.setStatus(STATUS_KEY, status.isEnabled ? undefined : ctx.ui.theme.fg("warning", text));
      } catch {}
    },
  };
}

export type SessionFeedback = ReturnType<typeof createSessionFeedback>;
