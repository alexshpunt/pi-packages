import { Context, Layer } from "effect";
import type { InstanceRegistryServices, MarkRebuildHook, ReleaseSessionQueriesHook } from "./types.js";

function sharedHooks<Hook>(key: string): Set<Hook> {
	const symbol = Symbol.for(key);
	const globals = globalThis as Record<symbol, unknown>;
	const hooks = globals[symbol] as Set<Hook> | undefined;
	if (hooks) return hooks;
	const created = new Set<Hook>();
	globals[symbol] = created;
	return created;
}

export function createInstanceRegistry(): InstanceRegistryServices {
	const rebuildHooks = sharedHooks<MarkRebuildHook>("claude-bridge:markRebuildHooks");
	const releaseHooks = sharedHooks<ReleaseSessionQueriesHook>("claude-bridge:releaseSessionQueriesHooks");
	let rebuild: MarkRebuildHook | undefined;
	let release: ReleaseSessionQueriesHook | undefined;
	return {
		bindRebuildHook(hook: MarkRebuildHook) {
			if (rebuild && rebuild !== hook) throw new Error("Rebuild hook already bound");
			rebuild = hook;
			rebuildHooks.add(hook);
		},
		bindReleaseHook(hook: ReleaseSessionQueriesHook) {
			if (release && release !== hook) throw new Error("Release hook already bound");
			release = hook;
			releaseHooks.add(hook);
		},
		enlistRebuildHook() { if (rebuild) rebuildHooks.add(rebuild); },
		withdrawRebuildHook() { if (rebuild) rebuildHooks.delete(rebuild); },
		enlistReleaseHook() { if (release) releaseHooks.add(release); },
		withdrawReleaseHook() { if (release) releaseHooks.delete(release); },
		sponsorMarkRebuildForSession(sessionId: string | null, event: string) {
			for (const hook of rebuildHooks) hook(sessionId, event);
		},
		sponsorReleaseSessionQueries(sessionId: string) {
			for (const hook of releaseHooks) hook(sessionId);
		},
	};
}
export class InstanceRegistry extends Context.Service<InstanceRegistry, InstanceRegistryServices>()("claude-bridge/InstanceRegistry") {}
export const InstanceRegistryLive = Layer.sync(InstanceRegistry, createInstanceRegistry);
