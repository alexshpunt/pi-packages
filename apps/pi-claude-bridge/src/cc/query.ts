import { query } from "@anthropic-ai/claude-agent-sdk";



export interface SdkQueryClientServices {
	readonly invokeQuery: (input: Parameters<typeof query>[0]) => ReturnType<typeof query>;
	readonly setQuery: (fn: typeof query | null) => void;
}

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
