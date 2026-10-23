import { Context, Effect, Layer } from "effect";
import type { MirrorStoreDependencies, MirrorStoreServices, SessionState } from "./types.js";
import { Diagnostics } from "../../diagnostics/service.js";
import { recordSessionLink } from "./continuity.js";

export function createMirrorStore({ diagnostics }: MirrorStoreDependencies): MirrorStoreServices {
	const sharedSessions = new Map<string, SessionState>();
	const historyRewrittenBySession = new Set<string>();
	const keyFor = (sessionId: string | null | undefined) => sessionId ?? "(none)";
	function sessionStateFor(sessionId: string | null | undefined): Readonly<SessionState> | null {
		return sharedSessions.get(keyFor(sessionId)) ?? null;
	}
	function setSessionStateFor(sessionId: string | null | undefined, state: SessionState | null): void {
		if (state === null) sharedSessions.delete(keyFor(sessionId));
		else {
			sharedSessions.set(keyFor(sessionId), state);
			recordSessionLink(sessionId, state.sessionId, state.cwd, diagnostics.debug);
		}
	}
	function markRebuildForSession(sessionId: string | null, event: string): void {
		const state = sharedSessions.get(keyFor(sessionId));
		if (state) {
			sharedSessions.set(keyFor(sessionId), { ...state, needsRebuild: true });
			diagnostics.debug(`${event}: marking needsRebuild on session ${state.sessionId.slice(0, 8)}`);
		} else diagnostics.debug(`${event}: history rewritten, no session to mark yet`);
		if (sessionId) historyRewrittenBySession.add(sessionId);
	}
	return {
		sharedSessions: sharedSessions as ReadonlyMap<string, Readonly<SessionState>>,
		historyRewrittenBySession: historyRewrittenBySession as ReadonlySet<string>,
		sessionStateFor,
		setSessionStateFor,
		markRebuildForSession,
		advanceCursor(sessionId: string | null | undefined, cursor: number) {
			const state = sharedSessions.get(keyFor(sessionId));
			if (state) state.cursor = cursor;
		},
		consumeRewrite(sessionId: string | null) { if (sessionId) historyRewrittenBySession.delete(sessionId); },
		clearHistoryRewrites() { historyRewrittenBySession.clear(); },
		clear() { sharedSessions.clear(); historyRewrittenBySession.clear(); },
	};
}
export class SessionStore extends Context.Service<SessionStore, MirrorStoreServices>()("claude-bridge/SessionStore") {}
export const SessionStoreLive = Layer.effect(SessionStore, Effect.gen(function* () {
	return createMirrorStore({ diagnostics: yield* Diagnostics });
}));
