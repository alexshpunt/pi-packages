import type { createToolServer } from "../../adapters/claude/mcp-server.js";
import type { PromptStream } from "../../adapters/claude/types.js";
import type { ProviderConfigurationServices } from "../../configuration/types.js";
import type { LoggingServices } from "../../diagnostics/types.js";
import type { QueryContext } from "../query/state.js";
import type { MirrorStoreServices } from "../session/types.js";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { Context, Tool } from "@earendil-works/pi-ai";
import type { Effect } from "effect";

export type McpContent = Array<
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
>;

export interface McpResult {
	content: McpContent;
	isError?: boolean;
	toolCallId?: string;
	[key: string]: unknown;
}

export interface ToolBridgeServices {
	readonly buildMcpServers: (tools: Tool[], queryCtx: QueryContext) => Record<string, ReturnType<typeof createToolServer>> | undefined;
	readonly deliverToolResults: (c: QueryContext, results: McpResult[], steer: ContentBlockParam[] | null, contextLength: number) => Effect.Effect<void>;
	readonly drainForAbort: (c: QueryContext, promptStream: PromptStream) => void;
	readonly extractAllToolResults: (context: Context) => McpResult[];
	readonly mapToolArgs: (toolName: string, args: Record<string, unknown> | undefined) => Record<string, unknown>;
	readonly piToolNameFor: (name: string, customToolNameToPi: Map<string, string>) => string | undefined;
	readonly resolveMcpTools: (context: Context) => {
		mcpTools: Tool[];
		customToolNameToSdk: Map<string, string>;
		customToolNameToPi: Map<string, string>;
	};
}

export interface ToolBridgeDependencies {
	diagnostics: LoggingServices;
	sessions: MirrorStoreServices;
	configuration: ProviderConfigurationServices;
}
