import type { PromptStream, SdkQueryClientServices } from "../../adapters/claude/types.js";
import type { InstanceRegistryServices, ProviderErrorsServices, StreamEventsServices } from "../../adapters/pi/types.js";
import type { ProviderConfigurationServices } from "../../configuration/types.js";
import type { LoggingServices } from "../../diagnostics/types.js";
import type { PlanDetectionServices } from "../models/types.js";
import type { ProviderPromptsServices } from "../prompt/types.js";
import type { MirrorStoreServices, SessionSyncServices, SyncResult } from "../session/types.js";
import type { McpResult, ToolBridgeServices } from "../tool-bridge/types.js";
import type { QueryContext } from "./state.js";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Effect, Scope } from "effect";

export interface ProviderQueryCompletionInput {
	queryOptions: NonNullable<Parameters<typeof query>[0]["options"]>;
	promptStream: PromptStream;
	queryCtx: QueryContext;
	customToolNameToPi: Map<string, string>;
	model: Model<any>;
	options: SimpleStreamOptions | undefined;
	isReentrant: boolean;
	syncResult: SyncResult;
	cwd: string;
	cliModel: string;
	context: Context;
	initialPromptAck: Effect.Effect<void, Error>;
}

export interface QueryCompletionServices {
	readonly abandonedQueries: WeakSet<object>;
	readonly discardRewrittenQuery: (c: QueryContext) => void;
	readonly startProviderQuery: (input: ProviderQueryCompletionInput) => Effect.Effect<void, unknown>;
}

export interface QueryConsumerServices {
	readonly consumeQuery: (sdkQuery: ReturnType<typeof query>, toolNames: Map<string, string>, model: Model<any>, wasAborted: () => boolean, context: QueryContext) => Effect.Effect<{ capturedSessionId?: string }, unknown, Scope.Scope>;
}

export type QueryPhase = "active" | "closing" | "closed";

export type QueryEndReason = "completed" | "failed" | "aborted" | "discarded";

export interface QueryRegistryServices {
	readonly activeQueryContexts: Set<QueryContext>;
	readonly contextForToolResults: (results: McpResult[]) => QueryContext | undefined;
	readonly enlistReleaseHook: () => void;
	readonly hasQueryInFlightForSession: (piSessionId: string | null | undefined) => boolean;
	readonly isSessionQueryActive: (piSessionId: string | null | undefined) => boolean;
	readonly markRunnerShutdown: () => void;
	readonly registerActiveQuery: (context: QueryContext) => void;
	readonly releaseSessionQueryContext: (piSessionId: string | null | undefined) => void;
	readonly reportLeaks: (label: string) => void;
	readonly sessionQueryContextFor: (piSessionId: string | null | undefined) => QueryContext;
	readonly sessionQueryContexts: Map<string, QueryContext>;
	readonly sponsorReleaseSessionQueries: (piSessionId: string) => void;
	readonly withdrawReleaseHook: () => void;
	readonly withdrawHooksIfIdle: () => void;
}

export interface QueryServiceServices {
	readonly streamClaudeAgentSdk: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => Effect.Effect<AssistantMessageEventStream, unknown>;
}

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export interface QueryCompletionDependencies {
	lifetimeScope: Scope.Scope;
	consumer: QueryConsumerServices;
	queries: QueryRegistryServices;
	sessions: MirrorStoreServices;
	diagnostics: LoggingServices;
	client: SdkQueryClientServices;
	plans: PlanDetectionServices;
	tools: ToolBridgeServices;
	events: StreamEventsServices;
}

export interface QueryConsumerDependencies {
	diagnostics: LoggingServices;
	errors: ProviderErrorsServices;
	configuration: ProviderConfigurationServices;
	events: StreamEventsServices;
}

export interface QueryRegistryDependencies {
	diagnostics: LoggingServices;
	instances: InstanceRegistryServices;
}

export interface QueryServiceDependencies {
	sessions: MirrorStoreServices;
	queries: QueryRegistryServices;
	configuration: ProviderConfigurationServices;
	diagnostics: LoggingServices;
	tools: ToolBridgeServices;
	completion: QueryCompletionServices;
	events: StreamEventsServices;
	prompts: ProviderPromptsServices;
	errors: ProviderErrorsServices;
	sync: SessionSyncServices;
}
