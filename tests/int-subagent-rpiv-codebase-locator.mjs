#!/usr/bin/env node
// Reproduction/regression for foreground rpiv-pi codebase-locator Agent calls
// hanging while claude-bridge has the parent Claude Code query active and the
// Agent MCP handler pending.
//
// This intentionally bypasses /skill:discover and invokes the same underlying
// mechanism directly: @tintinweb/pi-subagents Agent tool + rpiv-pi's pinned
// codebase-locator agent definition from @juicesharp/rpiv-pi v0.6.0.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const TEST_TIMEOUT = 240_000;
const SUBAGENTS_DIR = resolve(DIR, "../pi-subagents");
const RPIV_LOCATOR_FIXTURE = resolve(DIR, "tests/fixtures/rpiv-pi-v0.6.0-agents/codebase-locator.md");

assert.ok(existsSync(SUBAGENTS_DIR), `missing pinned pi-subagents checkout: ${SUBAGENTS_DIR}`);
const subagentsPackage = JSON.parse(readFileSync(join(SUBAGENTS_DIR, "package.json"), "utf8"));
assert.equal(
	subagentsPackage.version,
	"0.6.3",
	`expected ../pi-subagents to be pinned at 0.6.3, got ${subagentsPackage.version}`,
);
assert.ok(existsSync(RPIV_LOCATOR_FIXTURE), `missing rpiv codebase-locator fixture: ${RPIV_LOCATOR_FIXTURE}`);

const testAgentDir = mkdtempSync(join(tmpdir(), "subagent-rpiv-locator-dir-"));
const testProjectDir = mkdtempSync(join(tmpdir(), "subagent-rpiv-locator-project-"));
mkdirSync(join(testProjectDir, ".pi", "agents"), { recursive: true });
mkdirSync(join(testProjectDir, "src"), { recursive: true });
cpSync(RPIV_LOCATOR_FIXTURE, join(testProjectDir, ".pi", "agents", "codebase-locator.md"));
writeFileSync(join(testProjectDir, "package.json"), JSON.stringify({ name: "subagent-rpiv-locator-fixture", private: true }, null, 2));
writeFileSync(join(testProjectDir, "src", "rpiv_locator.ts"), "export const RPIV_LOCATOR_SENTINEL = 'rpiv-codebase-locator';\n");

const harness = createRpcHarness({
	name: "subagent-rpiv-codebase-locator",
	args: ["-e", SUBAGENTS_DIR, "--model", BRIDGE_MODEL],
	cwd: testProjectDir,
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TEST_TIMEOUT,
});

const { start, stop, send, waitForEvent, waitForMatch, collectText, DEBUG_LOG, RPC_LOG } = harness;

let finishing = false;
function finish(code, msg) {
	if (finishing) return;
	finishing = true;
	console.log(msg);
	if (code !== 0) {
		console.log(`  RPC log:    ${RPC_LOG}`);
		console.log(`  Debug log:  ${DEBUG_LOG}`);
		try { console.log(`  Debug tail:\n${readFileSync(DEBUG_LOG, "utf8").slice(-6000)}`); } catch {}
	}
	stop().then(() => {
		rmSync(testAgentDir, { recursive: true, force: true });
		rmSync(testProjectDir, { recursive: true, force: true });
		process.exit(code);
	});
}

start();
await new Promise((r) => setTimeout(r, 2000));

try {
	const collector = collectText();
	await send({
		type: "prompt",
		message: `Use the Agent tool exactly once.

Call it with:
- subagent_type: codebase-locator
- description: rpiv locator
- model: ${BRIDGE_MODEL}
- max_turns: 3
- run_in_background: false
- prompt: Find files related to RPIV_LOCATOR_SENTINEL in this repository. Return only file paths and matching line anchors. Do not ask questions.

After the Agent tool returns, reply exactly PARENT-SAW-RPIV-CODEBASE-LOCATOR.`,
	}, TEST_TIMEOUT);

	await waitForMatch(
		(msg) => msg.type === "tool_execution_start" && JSON.stringify(msg).includes("Agent"),
		"Agent tool_execution_start",
		TEST_TIMEOUT,
	);
	await waitForEvent("agent_end", TEST_TIMEOUT);
	const text = collector.stop();
	assert.match(
		text,
		/PARENT-SAW-RPIV-CODEBASE-LOCATOR/,
		`parent did not report Agent result completion. Text: ${text.slice(0, 500)}`,
	);

	const debugLog = readFileSync(DEBUG_LOG, "utf8");
	assert.match(debugLog, /mcp handler: Agent \[toolu_/, "debug log never showed the parent Agent MCP handler");
	assert.match(
		debugLog,
		/provider: fresh query setup, isReentrant=true/,
		"debug log never showed the subagent taking the reentrant fresh-query path",
	);
	assert.doesNotMatch(
		debugLog,
		/MCP handlers still waiting after delivering 0 results|tool handler\(s\) still waiting|currentPiStream overwritten/,
		"debug log contains stuck-handler/stream-overwrite signature",
	);

	finish(0, "PASS");
} catch (err) {
	finish(1, `FAIL: ${err.message}\n${err.stack}`);
}
