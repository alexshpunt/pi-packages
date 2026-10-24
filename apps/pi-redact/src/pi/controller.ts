import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { AnalyticsSession } from "../analytics-session.js";
import type { MaskingSession } from "../masking-session.js";
import { errorText } from "../notify.js";
import { SESSION_CHOICE_ENTRY, sessionChoiceData } from "../session-choice.js";
import {
  customTargetsEffect,
  globalSettingsPath,
  loadSettingsEffect,
  saveSettingsEffect,
  setGlobalEnabledEffect,
} from "../settings.js";
import type { AnalyticsCounts } from "../status.js";
import type { RedactController } from "./commands.js";
import type { SessionFeedback } from "./feedback.js";

/** Convert command callbacks into feature programs; only this adapter executes those programs for the UI. */
export function createRedactController(
  pi: Pick<ExtensionAPI, "appendEntry">,
  masking: Pick<MaskingSession, "snapshot" | "setSessionChoice" | "configure" | "preview">,
  analytics: Pick<AnalyticsSession, "counts" | "list" | "summarize" | "get" | "clear">,
  feedback: Pick<SessionFeedback, "snapshot" | "statusBar">,
): RedactController {
  const location = (ctx: ExtensionContext) => ({
    agentDir: getAgentDir(),
    cwd: ctx.cwd,
    isProjectTrusted: ctx.isProjectTrusted(),
  });

  function reload(ctx: ExtensionContext) {
    return Effect.gen(function* () {
      const loaded = yield* loadSettingsEffect(location(ctx));
      yield* masking.configure(loaded);
      feedback.statusBar(ctx, yield* masking.snapshot);
    });
  }

  return {
    status: (ctx) =>
      Effect.runSync(
        Effect.gen(function* () {
          const counts = yield* analytics
            .counts(() => ctx.sessionManager.getSessionId())
            .pipe(
              Effect.catch((error) =>
                Effect.succeed<AnalyticsCounts>({
                  error: `the analytics file could not be read: ${errorText(error.cause)}`,
                }),
              ),
            );
          return {
            ...(yield* masking.snapshot),
            globalSettingsPath: globalSettingsPath(getAgentDir()),
            stats: feedback.snapshot(),
            analytics: counts,
          };
        }),
      ),

    setSessionEnabled(ctx, isOn) {
      // Persist before changing memory; a failed append must not change the active choice.
      pi.appendEntry(SESSION_CHOICE_ENTRY, sessionChoiceData(isOn));
      Effect.runSync(
        Effect.gen(function* () {
          yield* masking.setSessionChoice(isOn);
          feedback.statusBar(ctx, yield* masking.snapshot);
        }),
      );
    },

    setGlobalEnabled: (ctx, isOn) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* setGlobalEnabledEffect(getAgentDir(), isOn);
          yield* reload(ctx);
        }),
      ),

    customTargets: (ctx) => Effect.runPromise(customTargetsEffect(location(ctx))),

    saveSettings: (ctx, scope, document) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* saveSettingsEffect(location(ctx), scope, document);
          yield* reload(ctx);
        }),
      ),

    preview: (text) => Effect.runSync(masking.preview(text).pipe(Effect.mapError((error) => error.cause))),

    // Every operation resolves the currently owned connection; UI readers never retain a stale store.
    analytics: () => ({
      list: (scope, limit) =>
        Effect.runSync(analytics.list(scope, limit).pipe(Effect.mapError((error) => error.cause))),
      summarize: (scope) => Effect.runSync(analytics.summarize(scope).pipe(Effect.mapError((error) => error.cause))),
      get: (id) => Effect.runSync(analytics.get(id).pipe(Effect.mapError((error) => error.cause))),
      clear: (scope) => Effect.runSync(analytics.clear(scope).pipe(Effect.mapError((error) => error.cause))),
    }),
  };
}
