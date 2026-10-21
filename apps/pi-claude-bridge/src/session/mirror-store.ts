import type { BridgeRuntime } from "../runtime.js";
import { recordSessionLink } from "./continuity.js";

export // --- Session persistence ---

interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// The pi session this CC conversation serves, from the provider call's
	// options.sessionId. Attribution for history rewrites: a subagent's
	// session_compact must not force a rebuild of a conversation that belongs
	// to a different pi session. Null until a provider call recorded it.
	piSessionId?: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY where we have just killed a CC subprocess: an abort, or a query
	// discarded because pi rewrote the history under it. The killed subprocess
	// may still be flushing a late "[Request interrupted by user]" record to the
	// session JSONL. Reusing the same sessionId/path would race that orphan write
	// into our fresh file and break CC's parent-uuid chain on the next resume.
	// When set, REBUILD takes a fresh UUID and leaves the old files untouched.
	// With no in-flight writer, an in-place rebuild replaces the JSONL while
	// retaining the tool-results directory referenced by carried content.
	forceRotate?: boolean;
}

export type MarkRebuildHook = (piSession: string | null, event: string) => void;

export interface MirrorStoreServices {
	readonly armStaleContexts: () => void;
	readonly enlistRebuildHook: () => void;
	readonly historyRewrittenBySession: Set<string>;
	readonly markRebuildForSession: (piSession: string | null, event: string) => void;
	readonly sessionStateFor: (piSessionId: string | null | undefined) => SessionState | null;
	readonly setSessionStateFor: (piSessionId: string | null | undefined, state: SessionState | null) => void;
	readonly sharedSessions: Map<string, SessionState>;
	readonly sponsorMarkRebuildForSession: (piSession: string | null, event: string) => void;
	readonly withdrawRebuildHook: () => void;
}

export function createMirrorStore(runtime: Pick<BridgeRuntime, "activeQueryContexts" | "debug">): MirrorStoreServices {
	/** The session key a pi session's provider calls address. Unattributed calls
	 *  (no options.sessionId — a direct caller or a host that omits it)
	 *  share the "(none)" bucket: they cannot be told apart, so they share the
	 *  pre-existing single-slot semantics. */
	function sessionKey(piSessionId: string | null | undefined): string {
		return piSessionId ?? "(none)";
	}

	/** Mirror of the CC conversation one pi session's turns are running on. One
	 *  entry per pi session: a bridge process serves several sessions at once
	 *  (pi-subagents children run their own AgentSessions), and a single shared
	 *  slot forced them to fight over it — a length-matching foreign sync could
	 *  REUSE or rebuild another session's CC file, and the completion capture was
	 *  last-writer-wins (a foreground child in the parent's first turn permanently
	 *  reassigned the parent's conversation). Keyed lookup removes the fight: each
	 *  session's reads, writes and teardown marks touch only its own mirror. */
	const sharedSessions = new Map<string, SessionState>();

	/** The mirror for `piSessionId`, or null when this session has none yet. */
	function sessionStateFor(piSessionId: string | null | undefined): SessionState | null {
		return sharedSessions.get(sessionKey(piSessionId)) ?? null;
	}

	/** Replace (or plant) the mirror for `piSessionId`. */
	function setSessionStateFor(piSessionId: string | null | undefined, state: SessionState | null): void {
		if (state === null) sharedSessions.delete(sessionKey(piSessionId));
		else {
			sharedSessions.set(sessionKey(piSessionId), state);
			recordSessionLink(piSessionId, state.sessionId, state.cwd, runtime.debug);
		}
	}

	// pi replaced one of its sessions' history (compact, tree) rather than appending
	// to it. Read on the tool-result path — the one provider call that never reaches
	// syncSharedSession — so a query parked at a tool boundary is discarded rather
	// than resumed (issue #101). Keyed by pi session id, not process-global: a bridge
	// process serves several pi sessions at once (subagents run their own
	// AgentSessions and can compact mid-run while the parent is parked), and
	// marking across that boundary kills healthy queries (or, worse, rebuilds the
	// parent around a compaction that never touched it).
	//
	// Holds real pi session ids only, never the "(none)" key: no production caller
	// marks with null (the rewrite events attribute via ctx.sessionManager), and
	// every reader guards on a non-null piSessionId — so a "(none)" entry could
	// never be matched or consumed, only leaked.
	const historyRewrittenBySession = new Set<string>();

	/** Handlers that arm rewrite staleness, one per module instance. Worktree-
	 *  spawned subagents can load this module fresh (pi's loader cache is keyed on
	 *  cwd, and a worktree cwd clears it), while the serving instance — whose
	 *  streamSimple the pi sessions actually call — is whoever registered first.
	 *  A fresh instance must forward its session's rewrites to the serving one.
	 *  Symbol.for: one registry per process, like SHARED_CAPTURES_KEY below. */
	const MARK_REBUILD_HOOKS_KEY = Symbol.for("claude-bridge:markRebuildHooks");

	const markRebuildHooks: Set<MarkRebuildHook> =
		((globalThis as Record<symbol, unknown>)[MARK_REBUILD_HOOKS_KEY] as Set<MarkRebuildHook> | undefined) ?? new Set();

	(globalThis as Record<symbol, unknown>)[MARK_REBUILD_HOOKS_KEY] = markRebuildHooks;

	/** pi mutated its messages array out from under us: force the next
	 *  syncSharedSession down REBUILD, and arm the discard above. `piSession`
	 *  is never null from an event handler (each pi session has its own runner).
	 *  The "(none)" key still covers the mirror for a hypothetical direct caller
	 *  with no session id, so such a rewrite forces the REBUILD side; the discard
	 *  set holds real ids only — see the comment on historyRewrittenBySession. */
	function markRebuildForSession(piSession: string | null, event: string): void {
		// The rewriting session's own mirror: the rewrite changed the history it was
		// built from, so its next sync must REBUILD rather than REUSE. Every other
		// session's mirror stays untouched — its conversation was never rewritten.
		const key = sessionKey(piSession);
		const state = sharedSessions.get(key);
		if (!state) {
			runtime.debug(`${event}: history rewritten, no session to mark yet`);
		} else {
			sharedSessions.set(key, { ...state, needsRebuild: true });
			runtime.debug(`${event}: marking needsRebuild on session ${state.sessionId.slice(0, 8)}`);
		}
		// Arming parked contexts cannot wait for delivery: the entry checks
		// `resultCtx.historyStale`, and a rewrite usually lands *while* the query is
		// parked (compaction runs inside pi's turn loop, not between provider calls).
		if (piSession) historyRewrittenBySession.add(piSession);
		armStaleContexts();
	}

	/** Copy each armed session's mark onto the parked queries built from it. */
	function armStaleContexts(): void {
		for (const c of runtime.activeQueryContexts) {
			if (c.piSessionId && historyRewrittenBySession.has(c.piSessionId)) c.historyStale = true;
		}
	}

	// This instance enlists. Session ids reaching any hook equal options.sessionId
	// on the serving instance's provider calls, so forwarding is safe: only the
	// owning instance's contexts and SessionState match the key. Adding again is a
	// no-op, so the stream entry can re-enlist a withdrawn instance unconditionally.
	function enlistRebuildHook(): void {
		markRebuildHooks.add(markRebuildForSession);
	}

	/** Leave the registry once this instance's runner has shut down idle. Pi loads a
	 *  fresh module instance on every reload and session replacement, so a hook left
	 *  behind would accumulate one entry per transition. */
	function withdrawRebuildHook(): void {
		markRebuildHooks.delete(markRebuildForSession);
	}

	enlistRebuildHook();

	/** Event handlers call this: it fans the rewrite out to every module instance
	 *  in the process, of which exactly one is serving provider traffic for any
	 *  given pi session. */
	function sponsorMarkRebuildForSession(piSession: string | null, event: string): void {
		for (const hook of markRebuildHooks) hook(piSession, event);
	}

	return {
		armStaleContexts,
		enlistRebuildHook,
		historyRewrittenBySession,
		markRebuildForSession,
		sessionStateFor,
		setSessionStateFor,
		sharedSessions,
		sponsorMarkRebuildForSession,
		withdrawRebuildHook,
	};
}
