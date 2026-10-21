import { expect, test } from "vitest";
import { buildProviderLaunchSettings, buildSummaryLaunchSettings } from "../src/cc/launch-settings.js";

test("provider launches with only bridge MCP pre-approved and always-strict config", () => {
	const options = buildProviderLaunchSettings({ strictMcpConfig: false });
	expect(options.permissionMode).toBe("dontAsk");
	expect(options.allowedTools).toStrictEqual(["mcp__custom-tools"]);
	expect(options.tools).toStrictEqual([]);
	expect(options.strictMcpConfig).toBe(true);
	expect(options.extraArgs).toBe(undefined);
	expect(options.settings.disableAllHooks).toBe(true);
});

test("summary keeps settings sources but excludes prompts, hooks, and persistence", () => {
	const options = buildSummaryLaunchSettings();
	expect(Object.hasOwn(options, "settingSources")).toBe(false);
	expect(options.settings.disableAllHooks).toBe(true);
	expect(options.settings.claudeMdExcludes).toStrictEqual(["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"]);
	expect(options.settings.autoMemoryEnabled).toBe(false);
	expect(options.strictMcpConfig).toBe(true);
	expect(options.tools).toStrictEqual([]);
	expect(options.persistSession).toBe(false);
	expect(options.maxTurns).toBe(1);
});

test("launch policy preserves executable and provider memory choices", () => {
	const provider = buildProviderLaunchSettings({ pathToClaudeCodeExecutable: "/fixture/claude", autoMemoryEnabled: true });
	const summary = buildSummaryLaunchSettings({ pathToClaudeCodeExecutable: "/fixture/claude", autoMemoryEnabled: true });
	expect(provider.pathToClaudeCodeExecutable).toBe("/fixture/claude");
	expect(summary.pathToClaudeCodeExecutable).toBe("/fixture/claude");
	expect(provider.settings.autoMemoryEnabled).toBe(true);
	expect(summary.settings.autoMemoryEnabled).toBe(false);
});
