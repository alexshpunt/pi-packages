import type { Config } from "../../configuration/types.js";
import type { McpResult } from "../../features/tool-bridge/types.js";
import type { Options, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Model } from "@earendil-works/pi-ai";
import type { Effect } from "effect";

export interface SdkQueryClientServices {
	readonly invokeQuery: (input: Parameters<typeof query>[0]) => ReturnType<typeof query>;
	readonly setQuery: (fn: typeof query | null) => void;
}

export interface McpToolDef {
	name: string;
	description: string;
	inputSchema: unknown;
	/** The `_meta` pi reports for the tool, put on its `tools/list` entry. */
	meta?: Record<string, unknown>;
	handler: (toolCallId: string) => Effect.Effect<McpResult, unknown> | Promise<McpResult>;
}

export interface QueryMessages {
	readonly next: Effect.Effect<IteratorResult<SDKMessage>, unknown>;
}

export interface PromptStream {
	readonly stream: AsyncGenerator<SDKUserMessage>;
	/** Queue synchronously; the effect completes only after the SDK resumes past yield. */
	readonly enqueue: (message: SDKUserMessage) => Effect.Effect<void, Error>;
	readonly push: (message: SDKUserMessage) => Promise<void>;
	readonly end: () => void;
	readonly fail: (error: Error) => void;
}

export interface QueryOptionsInput extends RequestOptionsInput {
	cwd: string;
	providerSettings?: Config["provider"];
	baseEnv?: NodeJS.ProcessEnv;
	resumeSessionId?: string | null;
	mcpServers?: Options["mcpServers"];
	debugOptions?: Pick<Options, "debug" | "debugFile" | "stderr">;
}

export interface RequestOptionsInput {
	model: Model<any>;
	cliModel: string;
	reasoning?: string;
	systemPrompt?: string;
}
