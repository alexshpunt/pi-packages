import type { createBridgeRuntime } from "./runtime.js";
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Effect } from "effect";

export interface RequestServices {
	readonly streamClaudeAgentSdk: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => Effect.Effect<AssistantMessageEventStream, unknown>;
}

export type BridgeRuntime = ReturnType<typeof createBridgeRuntime>;

export interface SessionEventsServices {
	readonly armStaleContexts: () => void;
	readonly markRebuildForSession: (sessionId: string | null, event: string) => void;
}
