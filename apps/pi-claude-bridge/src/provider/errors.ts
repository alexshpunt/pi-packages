import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";



export interface ProviderErrorsServices {
	readonly describeRateLimitFailure: (rejection: { rateLimitType?: string; resetsAt?: number }, failure: string) => string;
	readonly errorMessage: (err: unknown) => string;
	readonly resultErrorText: (message: SDKMessage) => string | undefined;
}

export function createProviderErrors(): ProviderErrorsServices {
	// --- Error handling ---

	function errorMessage(err: unknown): string {
		if (err instanceof Error) return err.message;
		if (err && typeof err === "object") {
			const obj = err as Record<string, unknown>;
			if (typeof obj.message === "string") return obj.message;
			if (typeof obj.error === "string") return obj.error;
			try { return JSON.stringify(err); } catch {}
		}
		return String(err);
	}

	/** Failure text for an SDK result, or undefined when it succeeded. CC reports API failures
	 *  (429 capacity, overload, prompt-too-long) with `is_error` on an otherwise success-shaped
	 *  result; the dedicated error subtypes carry `errors` instead. */
	function resultErrorText(message: SDKMessage): string | undefined {
		const result = message as SDKMessage & { subtype?: string; is_error?: boolean; result?: string; errors?: unknown; error?: unknown };
		if (result.subtype === "success") return result.is_error ? result.result || "Claude Code reported an error" : undefined;
		if (Array.isArray(result.errors) && result.errors.length) return result.errors.map(String).join("\n");
		if (typeof result.error === "string") return result.error;
		return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
	}

	/** Name a failure as a rate limit when a rejection preceded it.
	 *
	 *  pi has no typed rate-limit error — `stopReason` is only ever `"error"` and the sole carrier
	 *  is `errorMessage` — so everything that reacts to a rate limit pattern-matches that string:
	 *  pi-subagents gates `fallbackModels` on its own pattern list, and key-rotating extensions use
	 *  their own. Claude Code words a subscription limit as "You're out of extra usage · resets
	 *  6:30pm", which matches none of them, so an exhausted quota reads as a fatal error and the
	 *  fallback chain never runs (issue #58).
	 *
	 *  Leading with "Claude quota exceeded — rate limit" rather than appending keeps both phrases
	 *  in any truncated render, and avoids the `<tool> failed (exit N):` shape that pi-subagents
	 *  treats as a tool failure and refuses to retry. "quota exceeded" is on pi-ai's non-retryable
	 *  list, which wins over its retryable "rate limit" pattern, so pi hands the rejected window
	 *  straight to fallback instead of retrying a limit that resets in hours (issue #183). */
	function describeRateLimitFailure(rejection: { rateLimitType?: string; resetsAt?: number }, failure: string): string {
		const kind = rejection.rateLimitType ? ` (${rejection.rateLimitType})` : "";
		const resets = rejection.resetsAt ? ` — resets ${new Date(rejection.resetsAt * 1000).toLocaleTimeString()}` : ""; // resetsAt: Unix seconds (unit undocumented in the SDK; observed)
		return `Claude quota exceeded — rate limit${kind}${resets}: ${failure}`;
	}

	return {
		describeRateLimitFailure,
		errorMessage,
		resultErrorText,
	};
}
