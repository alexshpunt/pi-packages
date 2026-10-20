import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import { EnvironmentError } from "./types.js";

export const MODEL_ID = "claude-haiku-5-5";

export function assertSubscriptionAccount(account: AccountInfo): void {
	// accountInfo() omits apiKeySource for OAuth in CC 2.1.303. Unlike init,
	// this field is optional; the init event must still explicitly report none.
	if (account.apiProvider !== "firstParty" || account.apiKeySource !== undefined && account.apiKeySource !== "none")
		throw new EnvironmentError("subscription-login-required");
}

export function assertAllowedModel(modelId: string): void {
	if (![MODEL_ID, `claude-bridge/${MODEL_ID}`, `${MODEL_ID}[1m]`].includes(modelId))
		throw new EnvironmentError("only-haiku-5-5-is-allowed");
}

export function assertLiveEnvironment(env: NodeJS.ProcessEnv, modelId: string): void {
	assertAllowedModel(modelId);
	if (Object.keys(env).some(key => key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN" || key.startsWith("CLAUDE_CODE_USE_")))
		throw new EnvironmentError("subscription-environment-required");
}
