import { createLogging, type LoggingServices } from "./logging.js";
import { createProviderConfiguration, type ProviderConfigurationServices } from "./provider/configuration.js";
import { createProviderPrompts, type ProviderPromptsServices } from "./provider/prompts.js";
import { createProviderErrors, type ProviderErrorsServices } from "./provider/errors.js";
import { createPlanDetection, type PlanDetectionServices } from "./provider/plan-detection.js";
import { createMirrorStore, type MirrorStoreServices } from "./session/mirror-store.js";
import { createSessionSync, type SessionSyncServices } from "./session/sync.js";
import { createQueryRegistry, type QueryRegistryServices } from "./provider/query-context.js";
import { createStreamEvents, type StreamEventsServices } from "./provider/stream-events.js";
import { createToolBridge, type ToolBridgeServices } from "./provider/tool-bridge.js";
import { createQueryCompletion, type QueryCompletionServices } from "./provider/completion.js";
import { createIsolatedSummary, type IsolatedSummaryServices } from "./summary/isolated.js";
import { createProviderStream, type ProviderStreamServices } from "./provider/stream.js";
import { createSdkQueryClient, type SdkQueryClientServices } from "./cc/query.js";

/** A fresh runtime per entry evaluation preserves independent registration identities.
 *  Module factories receive only the services they use; shared Symbol registries
 *  remain at their existing process-wide boundaries. */
export type BridgeRuntime = LoggingServices &
	ProviderConfigurationServices &
	ProviderPromptsServices &
	ProviderErrorsServices &
	PlanDetectionServices &
	MirrorStoreServices &
	SessionSyncServices &
	QueryRegistryServices &
	StreamEventsServices &
	ToolBridgeServices &
	QueryCompletionServices &
	IsolatedSummaryServices &
	ProviderStreamServices &
	SdkQueryClientServices;

export function createBridgeRuntime(): BridgeRuntime {
	const runtime = {} as BridgeRuntime;
	const install = (services: object): void => { Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(services)); };
	install(createLogging());
	install(createProviderConfiguration());
	install(createProviderPrompts(runtime));
	install(createProviderErrors());
	install(createPlanDetection(runtime));
	install(createMirrorStore(runtime));
	install(createSessionSync(runtime));
	install(createQueryRegistry(runtime));
	install(createStreamEvents(runtime));
	install(createToolBridge(runtime));
	install(createQueryCompletion(runtime));
	install(createIsolatedSummary(runtime));
	install(createProviderStream(runtime));
	install(createSdkQueryClient());
	return runtime;
}
