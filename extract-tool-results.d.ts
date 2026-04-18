// Type declarations for extract-tool-results.js.

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

export function toolResultToMcpContent(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): McpContent;

export function extractAllToolResults(
	messages: Array<{ role: string; content?: unknown; toolCallId?: string; isError?: boolean; [key: string]: unknown }>,
): { results: McpResult[]; stopIdx: number };
