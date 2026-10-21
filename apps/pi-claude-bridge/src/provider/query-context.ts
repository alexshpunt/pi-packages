import type { BridgeRuntime } from "../runtime.js";

// Query state: QueryContext class.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// (subagents) each get their own QueryContext instance, managed by the provider runtime.
// Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { McpResult } from "../extract-tool-results.js";
import type { PromptStream } from "../prompt-stream.js";
import type { RateLimitInfo } from "../rate-limit.js";

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export class QueryContext {
	// Query-scoped (fully isolated per query)
	activeQuery: unknown | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	/** onResponse from the provider call that owns currentPiStream. */
	currentOnResponse: SimpleStreamOptions["onResponse"] | undefined;
	/** Latest rate_limit_event not yet reported. CC sends it after message_stop, when a
	 *  tool call has already ended the stream, so it waits for the next call's stream. */
	heldRateLimit: RateLimitInfo | undefined;
	latestCursor = 0;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	/** tool_use ids emitted this turn. Sole purpose is routing a delivered result
	 *  to the owning query when several queries are in flight — pairing a result
	 *  to its call is done by id from Claude's tools/call _meta, not from here. */
	turnToolCallIds: string[] = [];
	/** Streaming-input handle for the active query — how steers reach CC mid-turn. */
	promptStream: PromptStream | null = null;
	/** Binds a later run's abort signal to this query. Set by the run that opened it;
	 *  a run that continues it from a tool result (e.g. after pi terminated a tool
	 *  batch and ended the opening run) has no other way to stop it. */
	bindRunSignal: ((signal: AbortSignal | undefined) => void) | null = null;
	/** Last rate-limit rejection seen on this query. Claude Code sends it just before the
	 *  failure it caused, which is the only thing tying the two together. */
	rateLimitRejection: { rateLimitType?: string; resetsAt?: number } | null = null;
	/** Highest 5% utilization bucket we notified for, so repeat rate_limit_event spam is suppressed. */
	lastRateLimitWarnStep: number | null = null;
	lastRateLimitWarnThreshold: number | undefined;
	/** pi session this query serves, from SimpleStreamOptions.sessionId at fresh-query
	 *  setup. A bridge process serves several pi sessions at once (subagents run their
	 *  own AgentSessions), and history rewrites must only discard the rewriting
	 *  session's parked queries — this is the match key. Null when the host did not
	 *  supply an id.
	 */
	piSessionId: string | null = null;
	/** pi rewrote the history this query was built from (session_compact,
	 *  session_tree in its own pi session). Set by markRebuildForSession, consumed
	 *  by the tool-result delivery that discards the query. Not session-wide state:
	 *  it dies with the context it belongs to, so it cannot leak into later turns
	 *  the way a module flag does.
	 */
	historyStale = false;
	/** A steer never reached CC. A first query has no session mirror yet, so
	 *  completion must carry this into the mirror it creates. */
	missedSteer = false;

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;
	/** API message id from the last message_start, and whether its message_stop has
	 *  arrived. An `assistant` message under a different id while the stream is still
	 *  open is Claude Code's non-streaming fallback for a stalled stream. */
	turnStreamMessageId: string | undefined;
	turnStreamOpen = false;
	/** turnBlocks length at that message_start: where an abandoned attempt's blocks begin. */
	turnStreamBlockStart = 0;

	get turnBlocks(): Array<any> {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	/** Answer every parked MCP handler with `reason` and forget the turn's queued
	 *  results. Called when the query it belongs to is going away (abort, error,
	 *  normal end). Handlers must be *resolved*, not rejected: an error reply is
	 *  still a reply, and a handler left awaiting a subprocess that is gone keeps
	 *  CC's tools/call open forever, which wedges pi's turn behind it. */
	releasePendingToolCalls(reason: string): void {
		for (const pending of this.pendingToolCalls.values()) pending.resolve({ content: [{ type: "text", text: reason }] });
		this.pendingToolCalls.clear();
		this.pendingResults.clear();
	}

	resetTurnState(model: Model<any>): void {
		this.turnOutput = {
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		this.turnStreamMessageId = undefined;
		this.turnStreamOpen = false;
		this.turnStreamBlockStart = 0;
		// turnToolCallIds is NOT reset — it persists across tool-result delivery
		// callbacks within the same assistant message so results can be routed to
		// this query while its handlers are still pending.
	}
}

export type ReleaseSessionQueriesHook = (piSessionId: string) => void;

export interface QueryRegistryServices {
	readonly activeQueryContexts: Set<QueryContext>;
	readonly contextForToolResults: (results: McpResult[]) => QueryContext | undefined;
	readonly enlistReleaseHook: () => void;
	readonly hasQueryInFlightForSession: (piSessionId: string | null | undefined) => boolean;
	readonly isSessionQueryActive: (piSessionId: string | null | undefined) => boolean;
	readonly markRunnerShutdown: () => void;
	readonly releaseSessionQueryContext: (piSessionId: string | null | undefined) => void;
	readonly reportLeaks: (label: string) => void;
	readonly sessionQueryContextFor: (piSessionId: string | null | undefined) => QueryContext;
	readonly sessionQueryContexts: Map<string, QueryContext>;
	readonly sponsorReleaseSessionQueries: (piSessionId: string) => void;
	readonly withdrawReleaseHook: () => void;
	readonly withdrawHooksIfIdle: () => void;
}

export function createQueryRegistry(runtime: Pick<BridgeRuntime, "debug" | "withdrawRebuildHook">): QueryRegistryServices {
	const activeQueryContexts = new Set<QueryContext>();
	let runnerShutDown = false;

	/** Same bucket as the session mirror's key: calls without options.sessionId
	 *  cannot be told apart, so they share "(none)". */
	function queryStateKey(piSessionId: string | null | undefined): string {
		return piSessionId ?? "(none)";
	}

	/** Each pi session's top-level context: the one its non-reentrant queries reuse
	 *  turn after turn. A bridge process serves several pi sessions at once
	 *  (pi-subagents children run their own AgentSessions), so a single process-wide
	 *  slot let one session's live query make another session's fresh call look
	 *  reentrant — a shortened history then started clean instead of rebuilding.
	 *  Keyed lookup confines reentrancy to the session that is actually busy. */
	const sessionQueryContexts = new Map<string, QueryContext>();

	/** The top-level context for `piSessionId`, created on its first fresh query. */
	function sessionQueryContextFor(piSessionId: string | null | undefined): QueryContext {
		const key = queryStateKey(piSessionId);
		let c = sessionQueryContexts.get(key);
		if (!c) {
			c = new QueryContext();
			sessionQueryContexts.set(key, c);
		}
		return c;
	}

	/** Whether this session's top-level query is still running — the reentrancy test.
	 *  Completion clears activeQuery before ending the stream, so pi's next call in
	 *  the same session is not mistaken for reentry while cleanup is still pending. */
	function isSessionQueryActive(piSessionId: string | null | undefined): boolean {
		return (sessionQueryContexts.get(queryStateKey(piSessionId))?.activeQuery ?? null) !== null;
	}

	/** Whether any query serving this session, top-level or reentrant, is in flight. */
	function hasQueryInFlightForSession(piSessionId: string | null | undefined): boolean {
		const key = queryStateKey(piSessionId);
		for (const c of activeQueryContexts) {
			if (queryStateKey(c.piSessionId) === key) return true;
		}
		return false;
	}

	/** Drop an ended pi session's top-level context. A query still in flight keeps
	 *  running under its own run's signal and settles its handlers when it ends;
	 *  an idle context has its leftovers settled here. Other sessions are untouched,
	 *  and a repeated call finds nothing left to drop. */
	function releaseSessionQueryContext(piSessionId: string | null | undefined): void {
		const key = queryStateKey(piSessionId);
		const c = sessionQueryContexts.get(key);
		if (!c) return;
		sessionQueryContexts.delete(key);
		if (!activeQueryContexts.has(c)) c.releasePendingToolCalls("Session ended.");
		runtime.debug(`session ${key}: released top-level query state${activeQueryContexts.has(c) ? " (query still in flight)" : ""}`);
		withdrawHooksIfIdle();
	}

	/** Release hooks, one per module instance. The instance whose handler sees a
	 *  session_shutdown need not be the one serving that session's provider calls:
	 *  a worktree subagent loads this module fresh while its calls can still go to
	 *  the first instance's streamSimple. Like claude-bridge:markRebuildHooks, the
	 *  release fans out by session id, and each instance drops only its own entry. */
	const RELEASE_SESSION_QUERIES_HOOKS_KEY = Symbol.for("claude-bridge:releaseSessionQueriesHooks");
	const releaseSessionQueriesHooks: Set<ReleaseSessionQueriesHook> =
		((globalThis as Record<symbol, unknown>)[RELEASE_SESSION_QUERIES_HOOKS_KEY] as Set<ReleaseSessionQueriesHook> | undefined) ?? new Set();
	(globalThis as Record<symbol, unknown>)[RELEASE_SESSION_QUERIES_HOOKS_KEY] = releaseSessionQueriesHooks;

	/** Join the release fan-out. Adding again is a no-op, so the stream entry can
	 *  re-enlist a withdrawn instance unconditionally. */
	function enlistReleaseHook(): void {
		releaseSessionQueriesHooks.add(releaseSessionQueryContext);
	}

	/** Leave the fan-out once this instance's runner has shut down idle, so reloads
	 *  and session replacements do not accumulate one hook per module instance. */
	function withdrawReleaseHook(): void {
		releaseSessionQueriesHooks.delete(releaseSessionQueryContext);
	}

	/** Shutdown can precede the final query or another session's context release.
	 *  Keep the hooks until both registries are empty, and recheck on each release. */
	function withdrawHooksIfIdle(): void {
		if (!runnerShutDown || sessionQueryContexts.size > 0 || activeQueryContexts.size > 0) return;
		runtime.withdrawRebuildHook();
		withdrawReleaseHook();
	}

	function markRunnerShutdown(): void {
		runnerShutDown = true;
		withdrawHooksIfIdle();
	}

	enlistReleaseHook();

	/** session_shutdown calls this: every module instance releases the session. */
	function sponsorReleaseSessionQueries(piSessionId: string): void {
		for (const hook of releaseSessionQueriesHooks) hook(piSessionId);
	}

	/** Whatever a settled session left behind, named in one greppable line.
	 *
	 *  Every one of these should be empty once the last turn ends, and each is a leak
	 *  that costs something real: a retained context routes a later orphaned tool result
	 *  into the delivery path and returns a stream nobody ends; a pending tool call is an
	 *  MCP handler Claude Code is still waiting on; a live prompt stream is an unresolved
	 *  ack. The activeQueryContexts leak was present on every single happy-path run and
	 *  no test noticed, because nothing asserted that anything ends clean — so assert it
	 *  where the real sessions are, and let diag/audit-warnings.mjs scan for it. */
	function reportLeaks(label: string): void {
		const pendingCalls = [...activeQueryContexts].reduce((n, c) => n + c.pendingToolCalls.size, 0);
		const liveStreams = [...activeQueryContexts].filter((c) => c.promptStream !== null).length;
		if (activeQueryContexts.size === 0 && pendingCalls === 0 && liveStreams === 0) return;
		runtime.debug(
			`WARNING: ${label} left state behind — contexts=${activeQueryContexts.size} `
			+ `pendingToolCalls=${pendingCalls} promptStreams=${liveStreams}`,
		);
	}

	function contextForToolResults(results: McpResult[]): QueryContext | undefined {
		for (const result of results) {
			const id = result.toolCallId;
			if (!id) continue;
			for (const queryCtx of activeQueryContexts) {
				if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
					return queryCtx;
				}
			}
		}
		return undefined;
	}

	return {
		activeQueryContexts,
		contextForToolResults,
		enlistReleaseHook,
		hasQueryInFlightForSession,
		isSessionQueryActive,
		markRunnerShutdown,
		releaseSessionQueryContext,
		reportLeaks,
		sessionQueryContextFor,
		sessionQueryContexts,
		sponsorReleaseSessionQueries,
		withdrawReleaseHook,
		withdrawHooksIfIdle,
	};
}
