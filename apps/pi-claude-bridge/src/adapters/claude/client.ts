import { Context as ServiceContext, Layer } from "effect";
import type { ClaudeChildPurpose, GetChildEnv, SdkQueryClientServices } from "./types.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { callerChildEnv } from "./environment.js";

export function createSdkQueryClient(getChildEnv?: GetChildEnv): SdkQueryClientServices {
	// The SDK's query(), or a test double (see setQuery).
	let queryImpl: typeof query = query;

	function invokeQuery(input: Parameters<typeof query>[0], purpose?: ClaudeChildPurpose): ReturnType<typeof query> {
		if (!getChildEnv) return queryImpl(input);
		if (!purpose) throw new Error("claude-bridge: no child purpose for getChildEnv; Claude Code was not started");
		// Resolved per child, just before it starts, and placed only in this query's env.
		const env = { ...input.options?.env, ...callerChildEnv(getChildEnv, purpose) };
		return queryImpl({ ...input, options: { ...input.options, env } });
	}

	function setQuery(fn: typeof query | null): void { queryImpl = fn ?? query; }

	return {
		invokeQuery,
		setQuery,
	};
}

export class ClaudeClient extends ServiceContext.Service<ClaudeClient, SdkQueryClientServices>()("claude-bridge/ClaudeClient") {}
export const makeClaudeClientLive = (getChildEnv?: GetChildEnv) => Layer.sync(ClaudeClient, () => createSdkQueryClient(getChildEnv));
