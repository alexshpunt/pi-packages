import { Effect } from "effect";
import type { SessionState } from "../../src/features/session/types.js";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createBridgeRuntime } from "../../src/app/runtime.js";
import { PiBridge } from "../../src/adapters/pi/registration.js";
import { CC_CHILD_ENV } from "../../src/adapters/claude/environment.js";
import { effortForReasoning, thinkingForReasoning } from "../../src/adapters/claude/request-options.js";
import { toBridgeContext } from "../../src/adapters/pi/transcript.js";
import { Diagnostics } from "../../src/diagnostics/service.js";
import { Configuration } from "../../src/configuration/service.js";
import { Prompts } from "../../src/features/prompt/service.js";
import { Errors } from "../../src/adapters/pi/error-mapping.js";
import { PlanDetection } from "../../src/features/models/plan-detection.js";
import { SessionStore } from "../../src/features/session/mirror-store.js";
import { SessionSync } from "../../src/features/session/service.js";
import { QueryRegistry } from "../../src/features/query/registry.js";
import { StreamEvents } from "../../src/adapters/pi/stream-events.js";
import { QueryConsumer } from "../../src/features/query/consume.js";
import { ToolBridge } from "../../src/features/tool-bridge/service.js";
import { QueryCompletion } from "../../src/features/query/completion.js";
import { Summary } from "../../src/features/summary/service.js";
import { Requests } from "../../src/app/requests.js";
import { ClaudeClient } from "../../src/adapters/claude/client.js";
import { InstanceRegistry } from "../../src/adapters/pi/instance-registry.js";
import { SessionEvents } from "../../src/app/session-events.js";

/** Verification-only adapters. Production exports no test API or flat service bag. */
export function createBridgeHarness() {
	const runtime = createBridgeRuntime();
	const piBridge = runtime.runSync(PiBridge);
	const diagnostics = runtime.runSync(Diagnostics);
	const configuration = runtime.runSync(Configuration);
	const prompts = runtime.runSync(Prompts);
	const errors = runtime.runSync(Errors);
	const plans = runtime.runSync(PlanDetection);
	const sessions = runtime.runSync(SessionStore);
	const sync = runtime.runSync(SessionSync);
	const queries = runtime.runSync(QueryRegistry);
	const events = runtime.runSync(StreamEvents);
	const consumer = runtime.runSync(QueryConsumer);
	const tools = runtime.runSync(ToolBridge);
	const completion = runtime.runSync(QueryCompletion);
	const summary = runtime.runSync(Summary);
	const requests = runtime.runSync(Requests);
	const client = runtime.runSync(ClaudeClient);
	const instances = runtime.runSync(InstanceRegistry);
	const sessionEvents = runtime.runSync(SessionEvents);
	const harness = {
		...diagnostics,
		...configuration,
		...prompts,
		...errors,
		...plans,
		...sessions,
		...sync,
		...queries,
		...events,
		...tools,
		...completion,
		...summary,
		...requests,
		...client,
		...instances,
		...sessionEvents,
		runtime,
		register: piBridge.register,
		streamClaudeAgentSdk: piBridge.streamSimple,
		isolatedStreamFn: (...args: Parameters<typeof summary.isolatedStreamFn>) => runtime.runSync(summary.isolatedStreamFn(...args)),
		syncSharedSession: (...args: Parameters<typeof sync.syncSharedSession>) => runtime.runSync(sync.syncSharedSession(...args)),
		consumeQuery: (...args: Parameters<typeof consumer.consumeQuery>) => runtime.runPromise(Effect.scoped(consumer.consumeQuery(...args))),
		deliverToolResults: (...args: Parameters<typeof tools.deliverToolResults>) => runtime.runPromise(tools.deliverToolResults(...args)),
		startProviderQuery: (...args: Parameters<typeof completion.startProviderQuery>) => runtime.runSync(completion.startProviderQuery(...args)),
		resetSharedSession(sessionId?: string | null) {
			if (sessionId === undefined) sessions.clear();
			else sessions.setSessionStateFor(sessionId, null);
			sessions.clearHistoryRewrites();
		},
		getHistoryRewritten: () => sessions.historyRewrittenBySession.size > 0,
		isQueryAbandoned: (query: object) => completion.abandonedQueries.has(query),
		setSharedSession: (sessionId: string | null, state: SessionState | null) => sessions.setSessionStateFor(sessionId, state),
		getSharedSession: (sessionId: string | null = null) => sessions.sessionStateFor(sessionId),
		setPiUI: (ui: ExtensionUIContext | null) => { configuration.piUI = ui; },
		toBridgeContext, effortForReasoning, thinkingForReasoning, CC_CHILD_ENV,
		clearSessions: sessions.clear,
	};
	// Tests can configure the actual instance; spreading accessor properties would
	// otherwise snapshot settings and make the fixture differ from production.
	Object.defineProperty(harness, "debug", {
		get: () => diagnostics.debug,
		set: (value: typeof diagnostics.debug) => Object.defineProperty(diagnostics, "debug", { value, writable: true, configurable: true }),
		enumerable: true, configurable: true,
	});
	for (const service of [configuration, plans]) {
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(service))) {
			if (descriptor.get || descriptor.set) Object.defineProperty(harness, key, descriptor);
		}
	}
	return harness;
}

export function registerBridge(pi: ExtensionAPI, harness: ReturnType<typeof createBridgeHarness>): void {
	harness.register(pi);
}

export function runFixture<A, E>(operation: Effect.Effect<A, E>): Promise<A> {
	return Effect.runPromise(operation);
}
