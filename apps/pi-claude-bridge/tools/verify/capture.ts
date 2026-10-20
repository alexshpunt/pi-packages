import { randomUUID } from "node:crypto";
import type { Options, Query, query } from "@anthropic-ai/claude-agent-sdk";
import { createHarness } from "./harness.js";
import { fingerprint } from "./report.js";
import type { CheckContext, Facts } from "./types.js";
import { withWorkspace, type VerificationWorkspace } from "./workspace.js";

export interface CapturedQuery { options: Options; content: unknown; sessionId: string; }

export async function withCapturedQueries(context: CheckContext, run: (
	harness: ReturnType<typeof createHarness>, captures: CapturedQuery[], workspace: VerificationWorkspace,
) => Promise<Facts>): Promise<Facts> {
	return withWorkspace(false, async workspace => {
		const harness = createHarness(workspace, context.modelId);
		const captures: CapturedQuery[] = [];
		const sessionId = randomUUID();
		harness.runtime.setQuery((input: Parameters<typeof query>[0]) => {
			const captured: CapturedQuery = { options: input.options ?? {}, content: undefined, sessionId: input.options?.resume ?? sessionId };
			captures.push(captured);
			let source: AsyncIterator<unknown> | undefined;
			const iterator = (async function* () {
				if (typeof input.prompt === "string") captured.content = input.prompt;
				else {
					source = input.prompt[Symbol.asyncIterator]();
					captured.content = ((await source.next()).value as { message: { content: unknown } }).message.content;
				}
				yield { type: "system", subtype: "init", session_id: captured.sessionId, apiKeySource: "none" };
				yield { type: "assistant", message: { id: "msg_verify", content: [{ type: "text", text: "fixture answer" }], usage: { input_tokens: 1, output_tokens: 2 } } };
				yield { type: "result", subtype: "success", is_error: false, result: "fixture answer" };
			})();
			return Object.assign(iterator, { interrupt: async () => {}, close() { void source?.return?.(); } }) as unknown as Query;
		});
		try { return await run(harness, captures, workspace); }
		finally { await harness.close(); }
	});
}

export const OBSERVED_ENV_KEYS = [
	"CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE", "CLAUDE_CODE_PARENT_SESSION_ID", "CLAUDE_CODE_SESSION_ID",
	"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTO_COMPACT", "ENABLE_CLAUDEAI_MCP_SERVERS",
] as const;

function observeSystemPrompt(system: Options["systemPrompt"]): Facts | null {
	if (!system) return null;
	if (typeof system === "string") return fingerprint(system);
	if (Array.isArray(system)) return fingerprint(JSON.stringify(system));
	return system.type === "preset"
		? { type: system.type, preset: system.preset, snapshot: system.snapshot, append: fingerprint(system.append ?? "") }
		: { type: system.type, snapshot: system.snapshot, input: fingerprint(JSON.stringify(system.prompt)) };
}

export function observeOptions(options: Options): Facts {
	const settings = typeof options.settings === "object" ? options.settings : {};
	const system = options.systemPrompt;
	return {
		model: options.model ?? options.extraArgs?.model,
		effort: options.effort,
		thinking: options.thinking,
		permissionMode: options.permissionMode,
		strictMcpConfig: options.strictMcpConfig,
		settingSources: options.settingSources,
		persistSession: options.persistSession,
		maxTurns: options.maxTurns,
		tools: options.tools,
		mcpServers: Object.keys(options.mcpServers ?? {}),
		resume: options.resume,
		extraArgs: Object.fromEntries(["model", "strict-mcp-config", "thinking-display"].filter(key => Object.hasOwn(options.extraArgs ?? {}, key)).map(key => [key, options.extraArgs![key]])),
		settings: Object.fromEntries(["autoMemoryEnabled", "includeCoAuthoredBy", "includeGitInstructions", "disableAllHooks", "claudeMdExcludes", "skills"].filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]])),
		env: Object.fromEntries(OBSERVED_ENV_KEYS.filter(key => options.env?.[key] !== undefined).map(key => [key, options.env![key]])),
		systemPrompt: observeSystemPrompt(system),
	};
}
