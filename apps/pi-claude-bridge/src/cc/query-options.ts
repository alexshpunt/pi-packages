import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { buildChildEnv } from "./env.js";
import { buildProviderLaunchSettings, buildSummaryLaunchSettings } from "./launch-settings.js";
import { buildProviderRequestOptions, buildSummaryRequestOptions, type RequestOptionsInput } from "./request-options.js";

export interface QueryOptionsInput extends RequestOptionsInput {
	cwd: string;
	providerSettings?: Config["provider"];
	baseEnv?: NodeJS.ProcessEnv;
	resumeSessionId?: string | null;
	mcpServers?: Options["mcpServers"];
	debugOptions?: Pick<Options, "debug" | "debugFile" | "stderr">;
}

/** Builders own separate concerns. Never silently override an extraArgs flag. */
export function mergeQueryOptions(...parts: Partial<Options>[]): Options {
	const result: Partial<Options> = {};
	let extraArgs: Map<string, string | null>;
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
