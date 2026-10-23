import type { ProviderConfigurationServices } from "../../configuration/types.js";
import type { LoggingServices } from "../../diagnostics/types.js";
import type { PlanDetectionServices } from "../../features/models/types.js";
import type { ProviderPromptsServices } from "../../features/prompt/types.js";
import type { QueryContext } from "../../features/query/state.js";
import type { QueryRegistryServices } from "../../features/query/types.js";
import type { MirrorStoreServices } from "../../features/session/types.js";
import type { ToolBridgeServices } from "../../features/tool-bridge/types.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Effect } from "effect";

export interface ProviderErrorsServices {
	readonly describeRateLimitFailure: (rejection: { rateLimitType?: string; resetsAt?: number }, failure: string) => string;
	readonly errorMessage: (err: unknown) => string;
	readonly resultErrorText: (message: SDKMessage) => string | undefined;
}

export type MarkRebuildHook = (sessionId: string | null, event: string) => void;

export type ReleaseSessionQueriesHook = (sessionId: string) => void;

export interface InstanceRegistryServices {
	bindRebuildHook(hook: MarkRebuildHook): void;
	bindReleaseHook(hook: ReleaseSessionQueriesHook): void;
	enlistRebuildHook(): void;
	withdrawRebuildHook(): void;
	enlistReleaseHook(): void;
	withdrawReleaseHook(): void;
	sponsorMarkRebuildForSession(sessionId: string | null, event: string): void;
	sponsorReleaseSessionQueries(sessionId: string): void;
}

export type UsageWindow = { utilization?: number; resetsAt?: number };

export type RateLimitInfo = {
	status?: string;
	resetsAt?: number;
	rateLimitType?: string;
	overageStatus?: string;
	overageResetsAt?: number;
	unifiedWindows?: Record<string, UsageWindow | undefined>;
};

export type BridgeStream = (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

export interface PiBridgeServices {
	readonly streamSimple: BridgeStream;
	readonly register: (pi: ExtensionAPI) => void;
}

export interface StreamEventsServices {
	readonly claimCurrentPiStream: (stream: AssistantMessageEventStream, label: string, c: QueryContext, options: SimpleStreamOptions | undefined) => void;
	readonly reportHeldRateLimit: (context: QueryContext, model: Model<any>) => Effect.Effect<void>;
	readonly processStreamEvent: (message: SDKMessage, toolNames: Map<string, string>, model: Model<any>, context: QueryContext) => void;
	readonly processAssistantMessage: (message: SDKMessage, model: Model<any>, toolNames: Map<string, string>, context: QueryContext) => void;
	readonly ensureTurnStarted: (context: QueryContext) => void;
	readonly finalizeCurrentStream: (c: QueryContext, stopReason?: string) => void;
	readonly logServedContextWindow: (label: string, message: SDKMessage, model: Model<any>) => void;
	readonly markStreamComplete: (stream: AssistantMessageEventStream | null) => void;
	readonly newAssistantOutput: (model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string) => AssistantMessage;
}

/**
 * The usage counters Claude Code reports, mirroring `Usage` / `MessageDeltaUsage` in
 * @anthropic-ai/sdk. Every field is optional because `message_start`, `message_delta` and a
 * complete assistant message each carry a different subset.
 *
 * Not `Record<string, number | undefined>`: an index signature makes every property access
 * typecheck, which is what hid a read of `usage.reasoning_tokens` — a field no SDK version
 * has — for months.
 */
export type SdkUsage = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	output_tokens_details?: { thinking_tokens?: number | null } | null;
};

/** What updateUsage derived but does not store on the message, for the debug line in index.ts. */
export type UsageReport = {
	/** Cache-read share of the prompt, rounded to a whole percentage; 0 when the prompt is empty. */
	cachePct: number;
	/** Thinking tokens carried by THIS frame, absent when it carried none. Distinct from
	 *  `output.usage.reasoning`, which keeps the last value seen across frames. */
	reasoning?: number;
};

export interface PiBridgeDependencies {
	streamSimple: BridgeStream;
	diagnostics: LoggingServices;
	configuration: ProviderConfigurationServices;
	plans: PlanDetectionServices;
	sessions: MirrorStoreServices;
	prompts: ProviderPromptsServices;
	queries: QueryRegistryServices;
	instances: InstanceRegistryServices;
}

export interface StreamEventsDependencies {
	diagnostics: LoggingServices;
	tools: ToolBridgeServices;
}
