import type { SdkQueryClientServices } from "../../adapters/claude/types.js";
import type { ProviderErrorsServices, StreamEventsServices } from "../../adapters/pi/types.js";
import type { ProviderConfigurationServices } from "../../configuration/types.js";
import type { LoggingServices } from "../../diagnostics/types.js";
import type { ProviderPromptsServices } from "../prompt/types.js";
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Effect, Scope } from "effect";

export interface IsolatedSummaryServices {
	readonly isolatedStreamFn: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => Effect.Effect<AssistantMessageEventStream>;
}

export interface IsolatedSummaryDependencies {
	lifetimeScope: Scope.Scope;
	diagnostics: LoggingServices;
	errors: ProviderErrorsServices;
	prompts: ProviderPromptsServices;
	configuration: ProviderConfigurationServices;
	client: SdkQueryClientServices;
	events: StreamEventsServices;
}
