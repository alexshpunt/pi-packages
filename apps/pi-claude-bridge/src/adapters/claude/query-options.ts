import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { QueryOptionsInput } from "./types.js";
import { buildChildEnv } from "./environment.js";
import { buildProviderLaunchSettings, buildSummaryLaunchSettings } from "./launch-settings.js";
import { buildProviderRequestOptions, buildSummaryRequestOptions } from "./request-options.js";

/** Builders own separate concerns. Never silently override an extraArgs flag. */
export function mergeQueryOptions(...parts: Partial<Options>[]): Options {
	const result: Partial<Options> = {};
	let extraArgs: Map<string, string | null> | undefined;
	for (const { extraArgs: incoming, ...fields } of parts) {
		Object.assign(result, fields);
		if (incoming === undefined) continue;
		extraArgs ??= new Map();
		for (const [key, value] of Object.entries(incoming)) {
			if (extraArgs.has(key)) throw new Error(`Duplicate SDK extraArgs key: ${key}`);
			extraArgs.set(key, value);
		}
	}
	return { ...result, ...(extraArgs === undefined ? {} : { extraArgs: Object.fromEntries(extraArgs) }) };
}

export function buildProviderQueryOptions(input: QueryOptionsInput): Options {
	return mergeQueryOptions(
		buildProviderLaunchSettings(input.providerSettings),
		buildProviderRequestOptions(input),
		{
			cwd: input.cwd,
			env: buildChildEnv(input.baseEnv),
			...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
			...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
			...input.debugOptions,
		},
	);
}

export function buildSummaryQueryOptions(input: QueryOptionsInput): Options {
	return mergeQueryOptions(
		buildSummaryLaunchSettings(input.providerSettings),
		buildSummaryRequestOptions(input),
		{ cwd: input.cwd, env: buildChildEnv(input.baseEnv), ...input.debugOptions },
	);
}
