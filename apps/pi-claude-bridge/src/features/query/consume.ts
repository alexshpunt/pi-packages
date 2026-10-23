import { Context as ServiceContext, Effect, Layer, type Scope } from "effect";
import type { QueryConsumerDependencies, QueryConsumerServices } from "./types.js";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { Model } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
import { acquireQueryMessages } from "../../adapters/claude/messages.js";
import { Diagnostics } from "../../diagnostics/service.js";
import { Errors } from "../../adapters/pi/error-mapping.js";
import { Configuration } from "../../configuration/service.js";
import { StreamEvents } from "../../adapters/pi/stream-events.js";
import type { QueryContext } from "./state.js";

export function createQueryConsumer({ diagnostics, errors, configuration, events }: QueryConsumerDependencies): QueryConsumerServices {
	function consumeQuery(
		sdkQuery: ReturnType<typeof query>,
		customToolNameToPi: Map<string, string>,
		model: Model<any>,
		wasAborted: () => boolean,
		queryCtx: QueryContext,
	): Effect.Effect<{ capturedSessionId?: string }, unknown, Scope.Scope> {
		return Effect.gen(function* () {
			let capturedSessionId: string | undefined;
			const messages = yield* acquireQueryMessages(sdkQuery);
			while (true) {
				const next = yield* messages.next;
				if (next.done) break;
				const message = next.value;
				// CLAUDE_BRIDGE_RECORD_STREAM=<path> appends every SDK message consumeQuery
				// sees, one JSON object per line. Used by tests/lib/record-sdk-streams.mjs to
				// capture replay fixtures, so unit tests assert against message shapes Claude
				// Code really emitted rather than ones we imagined.
				const recordStreamPath = process.env.CLAUDE_BRIDGE_RECORD_STREAM;
				if (recordStreamPath) {
					try { appendFileSync(recordStreamPath, `${JSON.stringify(message)}\n`); } catch { /* Best-effort diagnostics only. */ }
				}
				if (wasAborted()) break;
				yield* events.reportHeldRateLimit(queryCtx, model);
				// Everything below the currentPiStream guard is content, which there is
				// nowhere to put once a turn has ended on a tool call. These three are not
				// content and must not share that gate:
				//
				// - stdin: nothing else closes the CLI's stdin now that the prompt is a
				//   streamed generator (isSingleUserTurn=false), so missing this hangs the query.
				// - the failure a `result` carries: it is the only record that the turn
				//   failed at all. Behind the guard, a 429 arriving at a tool boundary set
				//   no stopReason, no errorMessage, and logged nothing — the turn simply
				//   ended empty.
				// - rate-limit events: notifications to the user, which are most likely to
				//   fire during exactly the long tool-using turns the guard was skipping.
				let resultError: string | undefined;
				if (message.type === "result") {
					queryCtx.promptStream?.end();
					events.logServedContextWindow("result", message, model);
					resultError = errors.resultErrorText(message);
					if (resultError !== undefined) {
						// Consume the rejection alongside the failure it caused, so a later
						// unrelated failure on this query doesn't inherit the label.
						if (queryCtx.rateLimitRejection) {
							resultError = errors.describeRateLimitFailure(queryCtx.rateLimitRejection, resultError);
							queryCtx.rateLimitRejection = null;
						}
						diagnostics.debug(`consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`);
						if (queryCtx.turnOutput) {
							queryCtx.turnOutput.stopReason = "error";
							queryCtx.turnOutput.errorMessage = resultError;
						}
					}
				}
				if (message.type === "rate_limit_event") {
					const info = (message as any).rate_limit_info;
					diagnostics.debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
					if (info) queryCtx.heldRateLimit = info;
					yield* events.reportHeldRateLimit(queryCtx, model);
					if (info?.status === "rejected") {
						// Held so the failure Claude Code sends next can be named as a rate limit.
						queryCtx.rateLimitRejection = info;
						// The "rate limit reached" notice below supersedes warnings; re-arm so the next
						// window's warnings fire even if it opens straight into allowed_warning.
						queryCtx.lastRateLimitWarnStep = null;
						queryCtx.lastRateLimitWarnThreshold = undefined;
						// resetsAt is Unix seconds, not milliseconds.
						const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "unknown";
						configuration.piUI?.notify(`Claude subscription rate limit reached (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, "warning");
					} else if (info?.status === "allowed") {
						// Back under the threshold (window reset) — re-arm the warning dedupe.
						queryCtx.lastRateLimitWarnStep = null;
						queryCtx.lastRateLimitWarnThreshold = undefined;
					} else if (info?.status === "allowed_warning") {
						// utilization is a fraction (0..1); allowed_warning fires once it crosses surpassedThreshold.
						const percent = Math.round((info.utilization ?? 0) * 100);
						// The SDK emits one event per request, so only re-notify when the level
						// rises past a new 5% step or the threshold changes.
						const step = Math.floor(percent / 5);
						const rose = queryCtx.lastRateLimitWarnStep === null || step > queryCtx.lastRateLimitWarnStep;
						if (rose || info.surpassedThreshold !== queryCtx.lastRateLimitWarnThreshold) {
							queryCtx.lastRateLimitWarnStep = step;
							queryCtx.lastRateLimitWarnThreshold = info.surpassedThreshold;
							configuration.piUI?.notify(`Claude rate limit warning: ${percent}% used (${info.rateLimitType ?? ""})`, "warning");
						}
					}
					continue;
				}
				if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

				switch (message.type) {
					case "stream_event":
						events.processStreamEvent(message, customToolNameToPi, model, queryCtx);
						break;
					case "assistant":
						events.processAssistantMessage(message, model, customToolNameToPi, queryCtx);
						break;
					case "result": {
						// The failure itself was recorded above the guard, along with the served
						// context window. Fall back only if neither streaming nor an assistant
						// message has delivered the text. Thinking alone is not the answer.
						const hasAssistantText = queryCtx.turnBlocks.some(block => block.type === "text" && block.text);
						if (resultError === undefined && !queryCtx.turnSawStreamEvent && !hasAssistantText && message.subtype === "success") {
							events.ensureTurnStarted(queryCtx);
							const text = message.result || "";
							queryCtx.turnBlocks.push({ type: "text", text });
							const idx = queryCtx.turnBlocks.length - 1;
							queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
							queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
							queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
						}
						break;
					}
					case "system":
						if ((message as any).subtype === "init" && (message as any).session_id) {
							capturedSessionId = (message as any).session_id;
						}
						break;
					case "user":
						// SDK echo of the user prompt — no stream events to emit. Note it
						// carries only prompts and tool results: a steer CC drained at a
						// tool boundary is recorded in its session transcript as a
						// `queued_command` attachment and never reaches this stream, which
						// is why the mid-turn steering tripwire has to live in the
						// integration test.
						break;
					default:
						diagnostics.debug("consumeQuery: unhandled SDK message type", message.type);
						break;
				}
			}

			// DEBUG: trace when consumeQuery exits
			diagnostics.debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);

			return { capturedSessionId };
		});
	}

	return { consumeQuery };
}
export class QueryConsumer extends ServiceContext.Service<QueryConsumer, QueryConsumerServices>()("claude-bridge/QueryConsumer") {}
export const QueryConsumerLive = Layer.effect(QueryConsumer, Effect.gen(function* () {
	return createQueryConsumer({ diagnostics: yield* Diagnostics, errors: yield* Errors, configuration: yield* Configuration, events: yield* StreamEvents });
}));
