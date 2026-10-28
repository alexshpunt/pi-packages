import { Layer } from "effect";
import type { BridgeRuntimeOptions } from "./types.js";
import { DiagnosticsLive } from "../diagnostics/service.js";
import { ConfigurationLive } from "../configuration/service.js";
import { ErrorsLive } from "../adapters/pi/error-mapping.js";
import { makeClaudeClientLive } from "../adapters/claude/client.js";
import { InstanceRegistryLive } from "../adapters/pi/instance-registry.js";
import { PromptsLive } from "../features/prompt/service.js";
import { QueryRegistryLive } from "../features/query/registry.js";
import { SessionStoreLive } from "../features/session/mirror-store.js";
import { SessionSyncLive } from "../features/session/service.js";
import { SessionEventsLive } from "./session-events.js";
import { PlanDetectionLive } from "../features/models/plan-detection.js";
import { ToolBridgeLive } from "../features/tool-bridge/service.js";
import { StreamEventsLive } from "../adapters/pi/stream-events.js";
import { QueryConsumerLive } from "../features/query/consume.js";
import { SummaryLive } from "../features/summary/service.js";
import { QueryCompletionLive } from "../features/query/completion.js";
import { QueryServiceLive } from "../features/query/service.js";
import { RequestsLive } from "./requests.js";
import { PiBridgeLive } from "../adapters/pi/registration.js";

// Each layer object is shared within this graph; ManagedRuntime's memo map builds
// every instance-local service exactly once. No partial object or late DI writes.
export function makeBridgeLive({ getChildEnv }: BridgeRuntimeOptions) {
	const infrastructure = Layer.mergeAll(DiagnosticsLive, ConfigurationLive, ErrorsLive, makeClaudeClientLive(getChildEnv), InstanceRegistryLive);
	const state = Layer.mergeAll(PromptsLive, QueryRegistryLive, SessionStoreLive, PlanDetectionLive).pipe(Layer.provideMerge(infrastructure));
	const features = Layer.mergeAll(SessionSyncLive, SessionEventsLive, ToolBridgeLive).pipe(Layer.provideMerge(state));
	const streaming = StreamEventsLive.pipe(Layer.provideMerge(features));
	const consumption = QueryConsumerLive.pipe(Layer.provideMerge(streaming));
	const execution = Layer.mergeAll(SummaryLive, QueryCompletionLive).pipe(Layer.provideMerge(consumption));
	const query = QueryServiceLive.pipe(Layer.provideMerge(execution));
	const requests = RequestsLive.pipe(Layer.provideMerge(query));
	return PiBridgeLive.pipe(Layer.provideMerge(requests));
}
