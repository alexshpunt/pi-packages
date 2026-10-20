import { buildProviderQueryOptions } from "../cc/query-options.js";
import { effortForReasoning } from "../cc/request-options.js";
import { claudeCodeModelId } from "../models.js";
import { projectPromptCapture } from "../prompt-capture.js";
import type { PromptCapture } from "../prompt-capture.js";
import { makePromptStream } from "../prompt-stream.js";
import { userMessage } from "../prompt-stream.js";
import { QueryContext } from "./query-context.js";
import { sessionCwdFor } from "../session-cwd.js";
import { toBridgeContext } from "../transcript.js";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { BridgeRuntime } from "../runtime.js";



export interface ProviderStreamServices {
	readonly streamClaudeAgentSdk: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
}

export function createProviderStream(runtime: Pick<BridgeRuntime, "activeQueryContexts" | "buildMcpServers" | "claimCurrentPiStream" | "contextForToolResults" | "debug" | "deliverToolResults" | "diagDump" | "discardRewrittenQuery" | "enlistRebuildHook" | "enlistReleaseHook" | "errorMessage" | "extractAllToolResults" | "extractUserPrompt" | "extractUserPromptBlocks" | "hasQueryInFlightForSession" | "historyRewrittenBySession" | "isSessionQueryActive" | "isolatedStreamFn" | "longContextSettings" | "makeCliDebugOptions" | "markStreamComplete" | "newAssistantOutput" | "promptCaptures" | "providerSettings" | "resolveMcpTools" | "sessionQueryContextFor" | "sessionStateFor" | "showStartupNoticeOnce" | "startProviderQuery" | "steerBlocks" | "syncSharedSession">): ProviderStreamServices {
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
	function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		// An older registry can still reach this stream fn after the runner that loaded
		// it shut down and withdrew its hooks; serving again requires the fan-out.
		runtime.enlistRebuildHook();
		runtime.enlistReleaseHook();
		runtime.showStartupNoticeOnce();
		// pi hands providers a transcript (prompt/tools folded into system messages) — fold it
		// back out to the prompt/tools fields every cursor write, syncSharedSession call and
		// prompt-capture lookup below assumes (issue #106).
		context = toBridgeContext(context);

		// Pi marks compaction, branch-summary and bug-report calls with
		// cacheRetention:"none". Their prompts bypass capture boundaries, so route
		// them to an isolated persistSession:false CC process without session sync.
		if (options?.cacheRetention === "none") {
			runtime.debug(`provider: one-off summarizer call (cacheRetention none) routed to isolated summary, msgs=${context.messages.length}`);
			return runtime.isolatedStreamFn(model, context, options);
		}

		const stream = createAssistantMessageEventStream();

		// Which pi session this call serves — the attribution key for history rewrites
		// (session_compact / session_tree), for SessionState, and for reentrancy: a
		// bridge process serves several pi sessions at once, and another session's
		// live query says nothing about whether this one is busy.
		const piSessionId = options?.sessionId ?? null;

		// DEBUG: trace followUp message triggering
		const lastMsgRole = context.messages[context.messages.length - 1]?.role;
		runtime.debug(`provider: streamClaudeAgentSdk called, activeQuery=${runtime.isSessionQueryActive(piSessionId)}, lastMsgRole=${lastMsgRole}, isReentrant=${runtime.isSessionQueryActive(piSessionId)}`);

		let activeQuery = runtime.isSessionQueryActive(piSessionId);
		const allResults = runtime.activeQueryContexts.size > 0 ? runtime.extractAllToolResults(context) : [];
		let resultCtx = allResults.length > 0 ? runtime.contextForToolResults(allResults) : undefined;

		// pi rewrote its history while this query sat parked at a tool boundary, so the
		// query answers about a conversation that no longer exists. Discard it and let
		// this tool result carry the turn into a fresh query over the rewritten history.
		// The staleness mark is per pi session: a subagent's compaction (its own
		// AgentSession, sharing this process) must not discard the parent's parked
		// query, and vice versa.
		const rewrittenUnderQuery = Boolean(resultCtx?.historyStale);
		if (resultCtx && rewrittenUnderQuery) {
			runtime.discardRewrittenQuery(resultCtx);
			resultCtx = undefined;
			// Recomputed, not cleared: the discarded query may have been reentrant while
			// this session's top-level query still runs.
			activeQuery = runtime.isSessionQueryActive(piSessionId);
		}

		const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
		if (isReentrantUserQuery) {
			runtime.debug(`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${runtime.sessionQueryContextFor(piSessionId).pendingToolCalls.size}, ctx.msgs=${context.messages.length}`);
		}

		// --- Tool result delivery ---
		// Pi appends tool results to context and calls back. Extract this turn's results
		// (everything after the last assistant message) and match against waiting MCP
		// handlers. Results that arrive before their handler get queued in pendingResults.
		if (resultCtx) {
			runtime.claimCurrentPiStream(stream, "tool-result", resultCtx, options);
			resultCtx.resetTurnState(model);
			resultCtx.bindRunSignal?.(options?.signal);
			// A rewrite that armed the mark after this query parked gets copied here,
			// though markRebuildForSession usually reaches it directly.
			if (!resultCtx.historyStale && resultCtx.piSessionId && runtime.historyRewrittenBySession.has(resultCtx.piSessionId)) {
				resultCtx.historyStale = true;
			}
			// User messages (steer/followUp) pi injected into context during the
			// active query: a steer sent while a tool was executing, drained by pi at
			// the turn boundary and appended alongside the tool result.
			const steer = lastMsgRole === "user" ? runtime.steerBlocks(context.messages) : null;
			// Delivery is async because the steer must reach CC's stdin *before* the
			// tool result does — see deliverToolResults. Detached so the provider
			// still returns its stream synchronously.
			void runtime.deliverToolResults(resultCtx, allResults, steer, context.messages.length);
			// The shared cursor tracks the top-level conversation. A reentrant subagent
			// delivering its own results would drag it to that subagent's message count
			// — observed pulling a parent from 5 back to 3, which cost the parent's next
			// turn a full rebuild and a flushed prompt cache.
			const state = runtime.sessionStateFor(resultCtx.piSessionId);
			if (state) state.cursor = context.messages.length;
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
			runtime.debug(`provider: orphaned tool result after abort, emitting end_turn`);
			// With no query of its own in flight, the session this result belongs to is
			// the one whose turn just ended: its cursor advances to count the result
			// (options.sessionId is that session — pi emits the result event through the
			// same session's streamSimple call). Other sessions' queries do not hold it back.
			const orphanState = runtime.sessionStateFor(piSessionId);
			if (orphanState && !runtime.hasQueryInFlightForSession(piSessionId)) orphanState.cursor = context.messages.length;
			// No query owns this result, so there is no context to reset: resetTurnState
			// on a top-level context would replace a live query's turnOutput mid-stream,
			// stranding the blocks it had already emitted. A throwaway context just
			// supplies the empty message this turn ends with.
			const c = new QueryContext();
			c.resetTurnState(model);
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: c.turnOutput });
				runtime.markStreamComplete(stream);
				stream.end();
			});
			return stream;
		}

		// --- Fresh query ---

		// 1. Determine reentrancy. A query arriving while its own session's top-level
		//    query runs gets its own QueryContext, so the two can run concurrently.
		const isReentrant = activeQuery;
		const queryCtx = isReentrant ? new QueryContext() : runtime.sessionQueryContextFor(piSessionId);
		runtime.debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${runtime.activeQueryContexts.size}`);

		// Resolved first: an unaccountable system prompt fails this query before anything
		// is claimed or reset, leaving no half-built query behind — in particular no stream
		// claimed on the shared context that nobody will ever end.
		const { mcpTools, customToolNameToSdk, customToolNameToPi } = runtime.resolveMcpTools(context);
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
			promptCapture = runtime.promptCaptures.resolveOrDerive(context.systemPrompt);
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
			const output = runtime.newAssistantOutput(model, "", "error", runtime.errorMessage(err));
			queueMicrotask(() => {
				stream.push({ type: "error", reason: "error", error: output });
				runtime.markStreamComplete(stream);
				stream.end();
			});
			runtime.diagDump("prompt_capture_unresolved", {
				promptChars: context.systemPrompt?.length ?? 0,
				knownKeys: runtime.promptCaptures.size,
				reentrantUserQuery: isReentrantUserQuery,
				error: runtime.errorMessage(err),
			});
			return stream;
		}

		// 2. Fresh child context — constructor already gave us clean Maps and empty
		//    arrays. For a reused top-level context, clear explicitly.
		runtime.claimCurrentPiStream(stream, "fresh-query", queryCtx, options);
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
		const cliModel = claudeCodeModelId(model, runtime.longContextSettings);
		// Read before the consume below: with no query parked (an overflow retried
		// after compaction), the session's mark is the only sign of the rewrite.
		const hasHistoryRewrite = rewrittenUnderQuery || (piSessionId !== null && runtime.historyRewrittenBySession.has(piSessionId));
		const syncResult = runtime.syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel, piSessionId, isReentrant);
		// This query starts from the history pi has now: consume this session's
		// armed rewrite — a sibling pi session's stays armed for its own queries.
		if (piSessionId) runtime.historyRewrittenBySession.delete(piSessionId);
		const { sessionId: resumeSessionId } = syncResult;
		const promptBlocks = runtime.extractUserPromptBlocks(context.messages);
		let promptText = runtime.extractUserPrompt(context.messages) ?? "";

		// A turn continuing past a rewrite ends at its tool result, not at a
		// prompt, so say what happened rather than falling into the empty-prompt
		// recovery below — that one is for a shape we do not expect, and this is one
		// we do. The rebuilt session already ends with the tool result, placed after
		// the tool call it answers.
		if (hasHistoryRewrite && !promptText && !promptBlocks) {
			promptText = CONTINUE_AFTER_REWRITE_PROMPT;
			runtime.debug(`provider: continuing the turn after a rewritten history, ${context.messages.length} msgs rebuilt`);
		}
		if (isUnparkedToolResult && !promptText && !promptBlocks) {
			promptText = CONTINUE_AFTER_RESUME_PROMPT;
			runtime.debug(`provider: resuming the turn at a tool result with no parked query, ${context.messages.length} msgs`);
		}

		// Guard: empty prompt means the last context message isn't a user message.
		// This should never happen with per-query state — dump diagnostics if it does.
		if (!promptText && !promptBlocks) {
			runtime.diagDump("empty_prompt", {
				contextLength: context.messages.length,
				lastMsgRole: lastMsg?.role,
				isReentrant,
				activeQueryContexts: runtime.activeQueryContexts.size,
				activeQueryExists: queryCtx.activeQuery !== null,
				sharedSession: runtime.sessionStateFor(piSessionId) ? { sessionId: runtime.sessionStateFor(piSessionId)!.sessionId.slice(0, 8), cursor: runtime.sessionStateFor(piSessionId)!.cursor } : (runtime.sessionStateFor(null) ? { sessionId: runtime.sessionStateFor(null)!.sessionId.slice(0, 8), cursor: runtime.sessionStateFor(null)!.cursor } : null),
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
		void promptStream.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
			.catch((error) => runtime.debug(`provider: initial prompt push rejected:`, error));
		queryCtx.promptStream = promptStream;
		const mcpServers = runtime.buildMcpServers(mcpTools, queryCtx);

		const effort = effortForReasoning(model, options?.reasoning);
		const queryOptions = buildProviderQueryOptions({
			cwd, providerSettings: runtime.providerSettings, model, cliModel,
			reasoning: options?.reasoning, systemPrompt: systemPromptAppend,
			resumeSessionId, mcpServers, debugOptions: runtime.makeCliDebugOptions("provider"),
		});
		const strictMcpConfigEnabled = queryOptions.strictMcpConfig === true || queryOptions.extraArgs?.["strict-mcp-config"] === null;

		runtime.debug("provider: fresh query",
			`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
			`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
			`ctxFiles=${promptCapture?.contextFiles.length ?? 0} strictMcp=${strictMcpConfigEnabled}`,
			`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

		runtime.startProviderQuery({
			queryOptions, promptStream, queryCtx, customToolNameToPi, model, options,
			isReentrant, syncResult, cwd, cliModel, context,
		});

		return stream;
	}

	return {
		streamClaudeAgentSdk,
	};
}
