import { Context, Effect, Layer } from "effect";
import type { SessionEventsServices } from "./types.js";
import { InstanceRegistry } from "../adapters/pi/instance-registry.js";
import { QueryRegistry } from "../features/query/registry.js";
import { SessionStore } from "../features/session/mirror-store.js";

export class SessionEvents extends Context.Service<SessionEvents, SessionEventsServices>()("claude-bridge/SessionEvents") {}
export const SessionEventsLive = Layer.effect(SessionEvents, Effect.gen(function* () {
	const instances = yield* InstanceRegistry;
	const queries = yield* QueryRegistry;
	const sessions = yield* SessionStore;
	const armStaleContexts = () => {
		for (const context of queries.activeQueryContexts) {
			if (context.piSessionId && sessions.historyRewrittenBySession.has(context.piSessionId)) context.historyStale = true;
		}
	};
	const markRebuildForSession = (sessionId: string | null, event: string) => {
		sessions.markRebuildForSession(sessionId, event);
		armStaleContexts();
	};
	instances.bindRebuildHook(markRebuildForSession);
	return { armStaleContexts, markRebuildForSession };
}));
