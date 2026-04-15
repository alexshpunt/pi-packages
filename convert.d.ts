// Type declarations for convert.js (untyped JavaScript module)
// This file provides TypeScript typings for the convert.js module.

import type { Message as PiMessage } from "@mariozechner/pi-ai";
import type { Message as SessionMessage, ContentBlock, ToolResultBlock } from "cc-session-io";

export const PROVIDER_ID: string;
export const PI_TO_SDK_TOOL_NAME: Record<string, string>;

export function sanitizeToolId(id: string, cache: Map<string, string>): string;
export function mapPiToolNameToSdk(
	name: string,
	customToolNameToSdk?: Map<string, string>
): string;
export function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>
): string;

export function convertPiMessages(
	messages: PiMessage[],
	customToolNameToSdk?: Map<string, string>
): {
	anthropicMessages: SessionMessage[];
	sanitizedIds: Map<string, string>;
};
