import { Context as ServiceContext, Layer } from "effect";
import type { SdkQueryClientServices } from "./types.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

export function createSdkQueryClient(): SdkQueryClientServices {
	// The SDK's query(), or a test double (see setQuery).
	let queryImpl: typeof query = query;

	function invokeQuery(input: Parameters<typeof query>[0]): ReturnType<typeof query> { return queryImpl(input); }

	function setQuery(fn: typeof query | null): void { queryImpl = fn ?? query; }

	return {
		invokeQuery,
		setQuery,
	};
}

export class ClaudeClient extends ServiceContext.Service<ClaudeClient, SdkQueryClientServices>()("claude-bridge/ClaudeClient") {}
export const ClaudeClientLive = Layer.sync(ClaudeClient, createSdkQueryClient);
