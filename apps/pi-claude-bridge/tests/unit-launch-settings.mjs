import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProviderLaunchSettings, buildSummaryLaunchSettings } from "../src/cc/launch-settings.js";

test("provider launches with only bridge MCP pre-approved and always-strict config", () => {
	const options = buildProviderLaunchSettings({ strictMcpConfig: false });
	assert.equal(options.permissionMode, "dontAsk");
	assert.deepEqual(options.allowedTools, ["mcp__custom-tools"]);
	assert.deepEqual(options.tools, []);
	assert.equal(options.strictMcpConfig, true);
	assert.equal(options.extraArgs, undefined);
	assert.equal(options.settings.disableAllHooks, true);
});

test("summary keeps settings sources but excludes prompts, hooks, and persistence", () => {
	const options = buildSummaryLaunchSettings();
	assert.equal(Object.hasOwn(options, "settingSources"), false);
	assert.equal(options.settings.disableAllHooks, true);
	assert.deepEqual(options.settings.claudeMdExcludes, ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"]);
	assert.equal(options.settings.autoMemoryEnabled, false);
	assert.equal(options.strictMcpConfig, true);
	assert.deepEqual(options.tools, []);
	assert.equal(options.persistSession, false);
	assert.equal(options.maxTurns, 1);
});

test("launch policy preserves executable and provider memory choices", () => {
	const provider = buildProviderLaunchSettings({ pathToClaudeCodeExecutable: "/fixture/claude", autoMemoryEnabled: true });
	const summary = buildSummaryLaunchSettings({ pathToClaudeCodeExecutable: "/fixture/claude", autoMemoryEnabled: true });
	assert.equal(provider.pathToClaudeCodeExecutable, "/fixture/claude");
	assert.equal(summary.pathToClaudeCodeExecutable, "/fixture/claude");
	assert.equal(provider.settings.autoMemoryEnabled, true);
	assert.equal(summary.settings.autoMemoryEnabled, false);
});
