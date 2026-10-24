import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { AnalyticsSession } from "../analytics-session.js";
import type { MaskingSession } from "../masking-session.js";
import { restoreSessionChoice } from "../session-choice.js";
import { loadSettingsEffect } from "../settings.js";
import type { SessionFeedback } from "./feedback.js";

/** Restore the active branch and settings before publishing the new session's status. */
export function registerSessionLifecycle(
  pi: ExtensionAPI,
  masking: Pick<MaskingSession, "snapshot" | "setSessionChoice" | "configure">,
  analytics: Pick<AnalyticsSession, "close">,
  feedback: SessionFeedback,
): void {
  pi.on("session_start", (_event, ctx) =>
    Effect.runPromise(
      Effect.gen(function* () {
        feedback.reset();
        yield* analytics.close;
        yield* masking.setSessionChoice(restoreSessionChoice(ctx.sessionManager.getBranch()));
        const loaded = yield* loadSettingsEffect({
          agentDir: getAgentDir(),
          cwd: ctx.cwd,
          isProjectTrusted: ctx.isProjectTrusted(),
        });
        yield* masking.configure(loaded);
        feedback.statusBar(ctx, yield* masking.snapshot);
        for (const problem of loaded.problems) feedback.report(ctx, problem, "warning");
      }),
    ),
  );

  pi.on("session_tree", (_event, ctx) => {
    Effect.runSync(
      Effect.gen(function* () {
        yield* masking.setSessionChoice(restoreSessionChoice(ctx.sessionManager.getBranch()));
        feedback.statusBar(ctx, yield* masking.snapshot);
      }),
    );
  });

  pi.on("session_shutdown", () => {
    Effect.runSync(analytics.close);
  });
}
