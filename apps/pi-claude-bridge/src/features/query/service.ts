import { Context as ServiceContext, Effect, Layer } from "effect";
import type { PromptCapture } from "../prompt/types.js";
import type { QueryServiceDependencies, QueryServiceServices } from "./types.js";
import { SessionStore } from "../session/mirror-store.js";
import { QueryRegistry } from "./registry.js";
import { Configuration } from "../../configuration/service.js";
import { Diagnostics } from "../../diagnostics/service.js";
import { ToolBridge } from "../tool-bridge/service.js";
import { QueryCompletion } from "./completion.js";
import { StreamEvents } from "../../adapters/pi/stream-events.js";
import { Prompts } from "../prompt/service.js";
import { Errors } from "../../adapters/pi/error-mapping.js";
import { SessionSync } from "../session/service.js";
import { buildProviderQueryOptions } from "../../adapters/claude/query-options.js";
import { effortForReasoning } from "../../adapters/claude/request-options.js";
import { claudeCodeModelId } from "../models/policy.js";
import { projectPromptCapture } from "../prompt/capture.js";
import { makePromptStream } from "../../adapters/claude/prompt-input.js";
import { userMessage } from "../../adapters/claude/prompt-input.js";
import { QueryContext } from "./state.js";
import { sessionCwdFor } from "../../adapters/pi/session-cwd.js";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

export function createProviderStream({ sessions, queries, configuration, diagnostics, tools, completion, events, prompts, errors, sync }: QueryServiceDependencies): QueryServiceServices {
	/** The prompt a continuation query is opened with: the pi turn goes on, but its
	 *  last message is a tool result rather than a prompt, and query() cannot resume
	 *  a session without one. */
	const CONTINUE_AFTER_REWRITE_PROMPT =
		"[Your context was compacted. What precedes this is a summary plus the most recent messages, "
		+ "ending with the tool result you were waiting for. Continue the task from there.]";

	/** The prompt a resumed tool result is opened with: no query of this process
	 *  was parked on it (a restart, a crash, a stall), so the turn goes on from
	 *  history that ends at the result. */
	const CONTINUE_AFTER_RESUME_PROMPT =
		"[Your session was interrupted and resumed. What precedes this ends with the tool result "
		+ "you were waiting for. Continue the task from there.]";

	/** Provider entry point. Pi calls this for each new prompt and each tool result.
	 *  Two cases: tool result delivery (active query) or fresh query. */
	function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): Effect.Effect<AssistantMessageEventStream, unknown> {
		return Effect.gen(function* () {
			const stream = createAssistantMessageEventStream();

			// Which pi session this call serves — the attribution key for history rewrites
			// (session_compact / session_tree), for SessionState, and for reentrancy: a
			// bridge process serves several pi sessions at once, and another session's
			// live query says nothing about whether this one is busy.
			const piSessionId = options?.sessionId ?? null;

			// DEBUG: trace followUp message triggering
			const lastMsgRole = context.messages[context.messages.length - 1]?.role;
			diagnostics.debug(`provider: streamClaudeAgentSdk called, activeQuery=${queries.isSessionQueryActive(piSessionId)}, lastMsgRole=${lastMsgRole}, isReentrant=${queries.isSessionQueryActive(piSessionId)}`);

			let activeQuery = queries.isSessionQueryActive(piSessionId);
			const allResults = queries.activeQueryContexts.size > 0 ? tools.extractAllToolResults(context) : [];
			let resultCtx = allResults.length > 0 ? queries.contextForToolResults(allResults) : undefined;

			// pi rewrote its history while this query sat parked at a tool boundary, so the
			// query answers about a conversation that no longer exists. Discard it and let
			// this tool result carry the turn into a fresh query over the rewritten history.
			// The staleness mark is per pi session: a subagent's compaction (its own
			// AgentSession, sharing this process) must not discard the parent's parked
			// query, and vice versa.
			const rewrittenUnderQuery = Boolean(resultCtx?.historyStale);
			if (resultCtx && rewrittenUnderQuery) {
				completion.discardRewrittenQuery(resultCtx);
				resultCtx = undefined;
				// Recomputed, not cleared: the discarded query may have been reentrant while
				// this session's top-level query still runs.
				activeQuery = queries.isSessionQueryActive(piSessionId);
			}

			const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
			if (isReentrantUserQuery) {
				diagnostics.debug(`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${queries.sessionQueryContextFor(piSessionId).pendingToolCalls.size}, ctx.msgs=${context.messages.length}`);
			}

			// --- Tool result delivery ---
			// Pi appends tool results to context and calls back. Extract this turn's results
			// (everything after the last assistant message) and match against waiting MCP
			// handlers. Results that arrive before their handler get queued in pendingResults.
			if (resultCtx) {
				// Binding an already-aborted signal can synchronously finish this query.
				// Capture its owner before binding, not from the released session slot.
				const execution = resultCtx.execution;
				if (!execution) throw new Error("Active query has no resource owner");
				events.claimCurrentPiStream(stream, "tool-result", resultCtx, options);
				resultCtx.resetTurnState(model);
				resultCtx.bindRunSignal?.(options?.signal);
				// A rewrite that armed the mark after this query parked gets copied here,
				// though markRebuildForSession usually reaches it directly.
				if (!resultCtx.historyStale && resultCtx.piSessionId && sessions.historyRewrittenBySession.has(resultCtx.piSessionId)) {
					resultCtx.historyStale = true;
				}
				// User messages (steer/followUp) pi injected into context during the
				// active query: a steer sent while a tool was executing, drained by pi at
				// the turn boundary and appended alongside the tool result.
				const steer = lastMsgRole === "user" ? prompts.steerBlocks(context.messages) : null;
				// Delivery is async because the steer must reach CC's stdin *before* the
				// tool result does — see deliverToolResults. Detached so the provider
				// still returns its stream synchronously.
				// forkIn(startImmediately) runs even before checking a closed scope.
				// Do not refill queues that cancellation has already drained.
				if (execution.phase === "active") {
					yield* Effect.forkIn(
						tools.deliverToolResults(resultCtx, allResults, steer, context.messages.length),
						execution.scope,
						{ startImmediately: true },
					);
				}
				// The shared cursor tracks the top-level conversation. A reentrant subagent
				// delivering its own results would drag it to that subagent's message count
				// — observed pulling a parent from 5 back to 3, which cost the parent's next
				// turn a full rebuild and a flushed prompt cache.
				sessions.advanceCursor(resultCtx.piSessionId, context.messages.length);
				resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
				return stream;
			}

			// --- Orphaned tool result (e.g. user aborted a tool call) ---
			// The query is gone but pi still delivered the result. Nothing to do — just
			// emit end_turn so pi waits for the next real user message. The discard
			// branch above already siphoned off the stale-query case, which goes on to a
			// rebuild instead — that one has somewhere to deliver the result to.
			// Only when this call's own signal is aborted: after an abort during a tool
			// call, pi calls back with the run's (already aborted) signal. A result that
			// arrives otherwise -- after a restart (a durable host resuming a run), a
			// crash, a stall, or an overflow/quota retry -- has no parked query either, and
			// falls through to the fresh-query path, which resumes the CC session and
			// delivers it.
			const lastMsg = context.messages[context.messages.length - 1];
			const isUnparkedToolResult = lastMsg?.role === "toolResult" && !rewrittenUnderQuery;
			if (isUnparkedToolResult && options?.signal?.aborted) {
				diagnostics.debug(`provider: orphaned tool result after abort, emitting end_turn`);
				// With no query of its own in flight, the session this result belongs to is
				// the one whose turn just ended: its cursor advances to count the result
				// (options.sessionId is that session — pi emits the result event through the
				// same session's streamSimple call). Other sessions' queries do not hold it back.
				const orphanState = sessions.sessionStateFor(piSessionId);
				if (orphanState && !queries.hasQueryInFlightForSession(piSessionId)) sessions.advanceCursor(piSessionId, context.messages.length);
				// No query owns this result, so there is no context to reset: resetTurnState
				// on a top-level context would replace a live query's turnOutput mid-stream,
				// stranding the blocks it had already emitted. A throwaway context just
				// supplies the empty message this turn ends with.
				const c = new QueryContext();
				const output = c.resetTurnState(model);
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: output });
					events.markStreamComplete(stream);
					stream.end();
				});
				return stream;
			}

			// --- Fresh query ---

			// 1. Determine reentrancy. A query arriving while its own session's top-level
			//    query runs gets its own QueryContext, so the two can run concurrently.
			const isReentrant = activeQuery;
			const queryCtx = isReentrant ? new QueryContext() : queries.sessionQueryContextFor(piSessionId);
			diagnostics.debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${queries.activeQueryContexts.size}`);

			// Resolved first: an unaccountable system prompt fails this query before anything
			// is claimed or reset, leaving no half-built query behind — in particular no stream
			// claimed on the shared context that nobody will ever end.
			const { mcpTools, customToolNameToSdk, customToolNameToPi } = tools.resolveMcpTools(context);
			// Build from what Pi loaded for this run, so `--no-context-files` and
			// `--no-skills` reach Claude Code by leaving nothing to forward. A sub-agent's
			// custom override embeds its parent's assembled Pi prompt; recursive projection
			// replaces that exact inherited prompt with its already-safe portable parts.
			// Derive the key from the transcript replay (toBridgeContext), NOT from the
			// recorded keys: under a forced prompt the transcript head is projected via
			// transformContext after turn_start, so ctx.getSystemPrompt() is not the head.
			let promptCapture: PromptCapture | undefined;
			let systemPromptAppend: string | undefined;
			try {
				promptCapture = prompts.promptCaptures.resolveOrDerive(context.systemPrompt);
				systemPromptAppend = promptCapture
					? projectPromptCapture(promptCapture, {
						skillReadTool: mcpTools.some((tool) => tool.name === "read") ? "mcp" : "none",
					})
					: undefined;
			} catch (err) {
				// resolveOrDerive and projectPromptCapture throw to stop a turn that would lose
				// its instructions or leak pi's harness text. Report it on the stream, as pi-ai's
				// provider contract expects, so any caller — not only pi's agent loop, which
				// catches a throw — sees a failed turn rather than a synchronous exception.
				const output = events.newAssistantOutput(model, "", "error", errors.errorMessage(err));
				queueMicrotask(() => {
					stream.push({ type: "error", reason: "error", error: output });
					events.markStreamComplete(stream);
					stream.end();
				});
				diagnostics.diagDump("prompt_capture_unresolved", {
					promptChars: context.systemPrompt?.length ?? 0,
					knownKeys: prompts.promptCaptures.size,
					reentrantUserQuery: isReentrantUserQuery,
					error: errors.errorMessage(err),
				});
				return stream;
			}

			// 2. Fresh child context — constructor already gave us clean Maps and empty
			//    arrays. For a reused top-level context, clear explicitly.
			events.claimCurrentPiStream(stream, "fresh-query", queryCtx, options);
			// Usage and rejection markers belong to the query that received them. A query
			// that threw before its result must not relabel this query's error as quota exhaustion.
			queryCtx.heldRateLimit = undefined;
			queryCtx.rateLimitRejection = null;
			queryCtx.pendingToolCalls.clear();
			queryCtx.pendingResults.clear();
			// Stale ids would let a late result from the previous query route here via
			// contextForToolResults — which now means pushing its steer into this
			// query's stdin, not just mismatching a map.
			queryCtx.turnToolCallIds = [];
			queryCtx.resetTurnState(model);
			queryCtx.latestCursor = 0;
			// The served pi session, for rewrite attribution on delivery (issue #101
			// follow-up) and on SessionState. A fresh instance of this module inside a
			// worktree-spawned subagent has its own contexts; each records its own.
			queryCtx.piSessionId = options?.sessionId ?? null;
			// A discarded query's replacement reuses this context; without the reset its
			// first tool result would sit on armed staleness again (the mark is consumed
			// from the set, not from here) and re-discard a healthy query.
			queryCtx.historyStale = false;
			queryCtx.missedSteer = false;

			const cwd = sessionCwdFor(options?.sessionId);
			// cliModel is the actual id sent to Claude Code (may carry [1m]); model.id is the
			// pi-registered id. Log cliModel so debug lines reflect what CC actually received.
			const cliModel = claudeCodeModelId(model, configuration.longContextSettings);
			// Read before the consume below: with no query parked (an overflow retried
			// after compaction), the session's mark is the only sign of the rewrite.
			const hasHistoryRewrite = rewrittenUnderQuery || (piSessionId !== null && sessions.historyRewrittenBySession.has(piSessionId));
			const syncResult = yield* sync.syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel, piSessionId, isReentrant);
			// This query starts from the history pi has now: consume this session's
			// armed rewrite — a sibling pi session's stays armed for its own queries.
			sessions.consumeRewrite(piSessionId);
			const { sessionId: resumeSessionId } = syncResult;
			const promptBlocks = prompts.extractUserPromptBlocks(context.messages);
			let promptText = prompts.extractUserPrompt(context.messages) ?? "";

			// A turn continuing past a rewrite ends at its tool result, not at a
			// prompt, so say what happened rather than falling into the empty-prompt
			// recovery below — that one is for a shape we do not expect, and this is one
			// we do. The rebuilt session already ends with the tool result, placed after
			// the tool call it answers.
			if (hasHistoryRewrite && !promptText && !promptBlocks) {
				promptText = CONTINUE_AFTER_REWRITE_PROMPT;
				diagnostics.debug(`provider: continuing the turn after a rewritten history, ${context.messages.length} msgs rebuilt`);
			}
			if (isUnparkedToolResult && !promptText && !promptBlocks) {
				promptText = CONTINUE_AFTER_RESUME_PROMPT;
				diagnostics.debug(`provider: resuming the turn at a tool result with no parked query, ${context.messages.length} msgs`);
			}

			// Guard: empty prompt means the last context message isn't a user message.
			// This should never happen with per-query state — dump diagnostics if it does.
			if (!promptText && !promptBlocks) {
				diagnostics.diagDump("empty_prompt", {
					contextLength: context.messages.length,
					lastMsgRole: lastMsg?.role,
					isReentrant,
					activeQueryContexts: queries.activeQueryContexts.size,
					activeQueryExists: queryCtx.activeQuery !== null,
					sharedSession: sessions.sessionStateFor(piSessionId) ? { sessionId: sessions.sessionStateFor(piSessionId)!.sessionId.slice(0, 8), cursor: sessions.sessionStateFor(piSessionId)!.cursor } : (sessions.sessionStateFor(null) ? { sessionId: sessions.sessionStateFor(null)!.sessionId.slice(0, 8), cursor: sessions.sessionStateFor(null)!.cursor } : null),
					messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
				});
				// Recover: use a continuation prompt so the SDK doesn't send an empty text block
				promptText = "[continue]";
			}

			// Always stream the prompt rather than passing a string: a parked input
			// generator is what lets us write steers to CC's stdin mid-turn. The cost is
			// that `isSingleUserTurn` is false, so the SDK no longer closes stdin on the
			// first result — consumeQuery ends the stream explicitly instead, or the
			// query would never terminate.
			const promptStream = makePromptStream();
			const initialPromptAck = promptStream.enqueue(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]));
			queryCtx.promptStream = promptStream;
			const mcpServers = tools.buildMcpServers(mcpTools, queryCtx);

			const effort = effortForReasoning(model, options?.reasoning);
			const queryOptions = buildProviderQueryOptions({
				cwd, providerSettings: configuration.providerSettings, model, cliModel,
				reasoning: options?.reasoning, systemPrompt: systemPromptAppend,
				resumeSessionId, mcpServers, debugOptions: diagnostics.makeCliDebugOptions("provider"),
			});
			const strictMcpConfigEnabled = queryOptions.strictMcpConfig === true || queryOptions.extraArgs?.["strict-mcp-config"] === null;

			diagnostics.debug("provider: fresh query",
				`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
				`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
				`ctxFiles=${promptCapture?.contextFiles.length ?? 0} strictMcp=${strictMcpConfigEnabled}`,
				`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

			yield* completion.startProviderQuery({
				queryOptions, promptStream, initialPromptAck, queryCtx, customToolNameToPi, model, options,
				isReentrant, syncResult, cwd, cliModel, context,
			});

			return stream;
		});
	}

	return {
		streamClaudeAgentSdk,
	};
}

export class QueryService extends ServiceContext.Service<QueryService, QueryServiceServices>()("claude-bridge/QueryService") {}
export const QueryServiceLive = Layer.effect(QueryService, Effect.gen(function* () {
	const sessions = yield* SessionStore;
	const queries = yield* QueryRegistry;
	const configuration = yield* Configuration;
	const diagnostics = yield* Diagnostics;
	const tools = yield* ToolBridge;
	const completion = yield* QueryCompletion;
	const events = yield* StreamEvents;
	const prompts = yield* Prompts;
	const errors = yield* Errors;
	const sync = yield* SessionSync;
	return createProviderStream({ sessions, queries, configuration, diagnostics, tools, completion, events, prompts, errors, sync });
}));
