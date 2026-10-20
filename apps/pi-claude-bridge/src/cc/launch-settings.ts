import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { claudeCodeSettings, type Config } from "../config.js";

const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];

export function buildProviderLaunchSettings(provider: Config["provider"] = {}): Partial<Options> {
	return {
		tools: [],
		permissionMode: "dontAsk",
		allowedTools: ["mcp__custom-tools"],
		includePartialMessages: true,
		settings: {
			...claudeCodeSettings(provider),
			claudeMdExcludes: CLAUDE_MD_EXCLUDES,
			includeGitInstructions: false,
			disableAllHooks: true,
		},
		strictMcpConfig: true,
		...(provider.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: provider.pathToClaudeCodeExecutable } : {}),
	};
}

export function buildSummaryLaunchSettings(provider: Config["provider"] = {}): Partial<Options> {
	return {
		settings: { autoMemoryEnabled: false, claudeMdExcludes: CLAUDE_MD_EXCLUDES, disableAllHooks: true },
		tools: [],
		strictMcpConfig: true,
		// Keep user/project/local env and apiKeyHelper settings, not their prompts or hooks.
		skills: [],
		persistSession: false,
		maxTurns: 1,
		...(provider.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: provider.pathToClaudeCodeExecutable } : {}),
	};
}
