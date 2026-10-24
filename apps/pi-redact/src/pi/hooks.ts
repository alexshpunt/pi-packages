import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Exit } from "effect";
import type { RedactionSource } from "../analytics.js";
import type { AnalyticsSession } from "../analytics-session.js";
import { findMaskedWriteEffect, MASKED_WRITE_REASON } from "../guard.js";
import type { MaskingSession } from "../masking-session.js";
import { maskMessages, maskSessionEntriesInPlace, WITHHELD_TEXT } from "../messages.js";
import { errorText, notify } from "../notify.js";
import { REDACTION_MARKER } from "../render.js";
import { maskToolResult, withheldToolResult } from "../tool-results.js";
import { ANALYTICS_COMMAND } from "./commands.js";
import type { SessionFeedback } from "./feedback.js";

const MODEL_GUIDELINE =
  `Text shown as ${REDACTION_MARKER} replaces a sensitive value that pi-redact masked before it reached you; ` +
  "the real value still exists locally. Never write it into files or commands. Edit around such lines, " +
  "or ask the user to supply the value.";

/** Pi logs most thrown handler errors and continues with the original input: every masking exit is handled here. */
export function registerMaskingHooks(
  pi: ExtensionAPI,
  masking: Pick<MaskingSession, "isEnabled" | "stored" | "requests">,
  analytics: Pick<AnalyticsSession, "recorded">,
  feedback: Pick<SessionFeedback, "count" | "report" | "withheld">,
): void {
  const isEnabled = () => Effect.runSync(masking.isEnabled);

  function recorded<A, E>(ctx: ExtensionContext, source: RedactionSource, program: Effect.Effect<A, E>) {
    return analytics.recorded(
      source,
      program,
      () => ({ sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd }),
      (error) =>
        feedback.report(
          ctx,
          `masked content could not be saved for /${ANALYTICS_COMMAND}: ${errorText(error.cause)}`,
          "warning",
        ),
    );
  }

  pi.on("before_agent_start", (event) => {
    // Kept while masking is off: the history can still contain the marker, and the prompt stays cacheable.
    const guidelines = event.systemPromptOptions.promptGuidelines;
    if (!guidelines.includes(MODEL_GUIDELINE)) guidelines.push(MODEL_GUIDELINE);
  });

  pi.on("tool_result", (event, ctx) => {
    if (!isEnabled() || event.parentToolCallId !== undefined) return undefined;
    // Nested calls return to their parent; only that parent's result goes into the conversation.
    const result = Effect.runSyncExit(
      recorded(
        ctx,
        "tool result",
        masking.stored((engine) => maskToolResult(engine, event)),
      ),
    );
    if (Exit.isFailure(result)) {
      feedback.withheld(ctx, 1, `a ${event.toolName} result`);
      return withheldToolResult();
    }
    if (result.value) feedback.count("toolResults");
    return result.value;
  });

  // Runs after every context handler. Do not move this to context or a provider-only payload hook.
  pi.on("context_with_system", (event, ctx) => {
    if (!isEnabled()) return undefined;
    const result = Effect.runSyncExit(
      recorded(
        ctx,
        "model request",
        masking.requests((engine) => maskMessages(engine, event.messages)),
      ),
    );
    if (Exit.isFailure(result)) {
      try {
        ctx.abort();
      } catch {}
      feedback.withheld(ctx, event.messages.length, "a model request");
      const system = event.messages.filter((message) => message.role === "system");
      return { messages: [...system, { role: "user", content: WITHHELD_TEXT, timestamp: Date.now() }] };
    }
    const masked = result.value;
    feedback.withheld(ctx, masked.withheldCount, "a model request");
    if (masked.messages === event.messages) return undefined;
    feedback.count("requests");
    return { messages: masked.messages };
  });

  // Compaction calls the model without the context hooks. Preserve synchronous assignment order.
  pi.on("session_before_compact", (event, ctx) => {
    if (!isEnabled()) return undefined;
    const result = Effect.runSyncExit(
      Effect.gen(function* () {
        const preparation = event.preparation;
        const { summarized, prefix } = yield* recorded(
          ctx,
          "compaction",
          masking.requests((engine) => ({
            summarized: maskMessages(engine, preparation.messagesToSummarize),
            prefix: maskMessages(engine, preparation.turnPrefixMessages),
          })),
        );
        preparation.messagesToSummarize = summarized.messages;
        preparation.turnPrefixMessages = prefix.messages;
        const previousSummary = preparation.previousSummary;
        if (previousSummary !== undefined)
          preparation.previousSummary = yield* recorded(
            ctx,
            "compaction",
            masking.requests((engine) =>
              engine.labeled("previous compaction summary", () => engine.maskText(previousSummary)),
            ),
          );
        return summarized.withheldCount + prefix.withheldCount;
      }),
    );
    if (Exit.isFailure(result)) {
      feedback.report(ctx, "masking the compaction input failed; compaction was cancelled", "error");
      return { cancel: true };
    }
    feedback.withheld(ctx, result.value, "compaction");
    feedback.count("summaries");
    return undefined;
  });

  pi.on("session_before_tree", (event, ctx) => {
    if (!isEnabled() || !event.preparation.userWantsSummary) return undefined;
    const result = Effect.runSyncExit(
      recorded(
        ctx,
        "branch summary",
        masking.requests((engine) => maskSessionEntriesInPlace(engine, event.preparation.entriesToSummarize)),
      ),
    );
    if (Exit.isFailure(result)) {
      feedback.report(ctx, "masking the branch summary input failed; navigation was cancelled", "error");
      return { cancel: true };
    }
    feedback.withheld(ctx, result.value, "a branch summary");
    feedback.count("summaries");
    return undefined;
  });

  // The write guard stays on while masking is off: old history can still contain markers.
  pi.on("tool_call", async (event, ctx) => {
    const result = await Effect.runPromiseExit(findMaskedWriteEffect(event, ctx.cwd), { signal: ctx.signal });
    if (Exit.isFailure(result))
      return { block: true, reason: `pi-redact could not check this ${event.toolName} call for ${REDACTION_MARKER}.` };
    if (result.value === undefined) return undefined;
    feedback.count("blockedCalls");
    if (ctx.hasUI) notify(ctx, `pi-redact blocked writing ${REDACTION_MARKER} to ${result.value}`, "warning");
    return { block: true, reason: MASKED_WRITE_REASON };
  });
}
