import { Context as ServiceContext, Effect, Layer } from "effect";
import type { McpResult } from "../tool-bridge/types.js";
import type { QueryRegistryDependencies, QueryRegistryServices } from "./types.js";
import { Diagnostics } from "../../diagnostics/service.js";
import { InstanceRegistry } from "../../adapters/pi/instance-registry.js";
import { QueryContext } from "./state.js";

export function createQueryRegistry({ diagnostics, instances }: QueryRegistryDependencies): QueryRegistryServices {
	const activeQueryContexts = new Set<QueryContext>();
	let runnerShutDown = false;

	function registerActiveQuery(context: QueryContext): void {
		activeQueryContexts.add(context);
		// Synchronous discard can withdraw an ended runner's final hooks before
		// its replacement is prepared in the same call. A new owner re-enlists.
		instances.enlistRebuildHook();
		instances.enlistReleaseHook();
	}

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
		diagnostics.debug(`session ${key}: released top-level query state${activeQueryContexts.has(c) ? " (query still in flight)" : ""}`);
		withdrawHooksIfIdle();
	}

	const { enlistReleaseHook, withdrawReleaseHook, sponsorReleaseSessionQueries } = instances;
	instances.bindReleaseHook(releaseSessionQueryContext);

	/** Shutdown can precede the final query or another session's context release.
	 *  Keep the hooks until both registries are empty, and recheck on each release. */
	function withdrawHooksIfIdle(): void {
		if (!runnerShutDown || sessionQueryContexts.size > 0 || activeQueryContexts.size > 0) return;
		instances.withdrawRebuildHook();
		withdrawReleaseHook();
	}

	function markRunnerShutdown(): void {
		runnerShutDown = true;
		withdrawHooksIfIdle();
	}

	enlistReleaseHook();

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
		diagnostics.debug(
			`WARNING: ${label} left state behind — contexts=${activeQueryContexts.size} `
			+ `pendingToolCalls=${pendingCalls} promptStreams=${liveStreams}`,
		);
	}

	function contextForToolResults(results: McpResult[]): QueryContext | undefined {
		for (const result of results) {
			const id = result.toolCallId;
			if (!id) continue;
			for (const queryCtx of activeQueryContexts) {
				const execution = queryCtx.execution;
				if (!execution || execution.phase !== "active" || execution.query !== queryCtx.activeQuery) continue;
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
		registerActiveQuery,
		releaseSessionQueryContext,
		reportLeaks,
		sessionQueryContextFor,
		sessionQueryContexts,
		sponsorReleaseSessionQueries,
		withdrawReleaseHook,
		withdrawHooksIfIdle,
	};
}

export class QueryRegistry extends ServiceContext.Service<QueryRegistry, QueryRegistryServices>()("claude-bridge/QueryRegistry") {}
export const QueryRegistryLive = Layer.effect(QueryRegistry, Effect.gen(function* () {
	const diagnostics = yield* Diagnostics;
	const instances = yield* InstanceRegistry;
	return createQueryRegistry({ diagnostics, instances });
}));
