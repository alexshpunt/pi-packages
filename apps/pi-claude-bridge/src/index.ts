import { CC_CHILD_ENV } from "./cc/env.js";
import { effortForReasoning } from "./cc/request-options.js";
import { thinkingForReasoning } from "./cc/request-options.js";
import { toBridgeContext } from "./transcript.js";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { SessionState } from "./session/mirror-store.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBridgeRuntime } from "./runtime.js";
import { registerBridge } from "./provider/registration.js";

const runtime = createBridgeRuntime();

// @internal
export const __test = {
	setQuery: runtime.setQuery,
	resetSharedSession(piSessionId?: string | null) {
		// No id: full reset (the pre-map semantics — tests start from a blank slate).
		if (piSessionId === undefined) runtime.sharedSessions.clear();
		else runtime.setSessionStateFor(piSessionId, null);
		runtime.historyRewrittenBySession.clear();
	},
	markRebuildForSession: runtime.markRebuildForSession,
	getHistoryRewritten: () => runtime.historyRewrittenBySession.size > 0,
	historyRewrittenBySession: runtime.historyRewrittenBySession,
	armStaleContexts: runtime.armStaleContexts,
	discardRewrittenQuery: runtime.discardRewrittenQuery,
	contextForToolResults: runtime.contextForToolResults,
	isQueryAbandoned: (q: object) => runtime.abandonedQueries.has(q),
	get activeQueryContexts() {
		return runtime.activeQueryContexts;
	},
	setSharedSession(piSessionId: string | null, state: SessionState | null) {
		runtime.setSessionStateFor(piSessionId, state);
	},
	getSharedSession(piSessionId: string | null = null) {
		return runtime.sessionStateFor(piSessionId);
	},
	setPiUI(ui: ExtensionUIContext | null) {
		runtime.piUI = ui;
	},
	toBridgeContext,
	isolatedStreamFn: runtime.isolatedStreamFn,
	effortForReasoning,
	thinkingForReasoning,
	syncSharedSession: runtime.syncSharedSession,
	extractUserPromptBlocks: runtime.extractUserPromptBlocks,
	consumeQuery: runtime.consumeQuery,
	finalizeCurrentStream: runtime.finalizeCurrentStream,
	resultErrorText: runtime.resultErrorText,
	deliverToolResults: runtime.deliverToolResults,
	drainForAbort: runtime.drainForAbort,
	CC_CHILD_ENV,
	buildMcpServers: runtime.buildMcpServers,
	get promptCaptures() {
		return runtime.promptCaptures;
	},
};


export default function (pi: ExtensionAPI) {
	registerBridge(pi, runtime);
}
