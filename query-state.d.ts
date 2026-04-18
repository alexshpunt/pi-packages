// Type declarations for query-state.js.

import type { AssistantMessage, AssistantMessageEventStream, Model } from "@mariozechner/pi-ai";
import type { McpResult } from "./extract-tool-results.js";

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export class QueryContext {
	activeQuery: unknown | null;
	currentPiStream: AssistantMessageEventStream | null;
	latestCursor: number;
	pendingToolCalls: Map<string, PendingToolCall>;
	pendingResults: Map<string, McpResult>;
	turnToolCallIds: string[];
	nextHandlerIdx: number;
	deferredUserMessages: string[];

	turnOutput: AssistantMessage | null;
	turnStarted: boolean;
	turnSawStreamEvent: boolean;
	turnSawToolCall: boolean;

	readonly turnBlocks: Array<any>;
	resetTurnState(model: Model<any>): void;
}

export function ctx(): QueryContext;
export function stackDepth(): number;
export function pushContext(): void;
export function popContext(): void;
export function resetStack(): void;
