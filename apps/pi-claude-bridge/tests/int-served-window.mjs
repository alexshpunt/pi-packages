// Verifies logServedContextWindow fires on a real provider turn: after one
// bridge prompt, the debug log must contain a "served contextWindow=…"
// line emitted from consumeQuery's result handler (issue #18 diagnostics).
//
// Haiku keeps it cheap; the path is identical to opus/sonnet.

import { readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 120_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-5-5";

const testAgentDir = mkdtempSync(join(tmpdir(), "served-window-agent-"));
writeFileSync(join(testAgentDir, "settings.json"), JSON.stringify({}));

const harness = createRpcHarness({
	name: "served-window",
	args: ["--model", BRIDGE_MODEL],
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

test("a provider turn logs the served context window next to the registered one", async () => {
	await startAndWait();

	try {
		console.log("Single bridge prompt to exercise the provider result path...");
		const text = await promptAndWait('Reply with just the word "yes".');
		expect(text, `unexpected reply: ${text.slice(0, 200)}`).toMatch(/yes/i);

		const debug = readFileSync(DEBUG_LOG, "utf8");
		const line = debug.split("\n").find((l) => /result: served contextWindow=/.test(l));
		expect(line, `debug log has no "result: served contextWindow=" line.\n\nExcerpt:\n${debug.slice(-2000)}`).toBeTruthy();
		console.log(`  ${line.trim()}`);

		// The line must carry both the served value and the registered value so the
		// gap is observable in one place.
		expect(line, "missing served contextWindow number").toMatch(/served contextWindow=\d+/);
		expect(line, "missing registered number").toMatch(/registered=\d+/);
		expect(line, "missing servedModel").toMatch(/servedModel=/);

		// The bridge's invariant: pi's registered window must equal the window CC
		// actually serves, or pi's status bar and auto-compaction threshold drift
		// from reality (issue #24/#17). Account-agnostic — holds on any plan.
		const served = Number(line.match(/served contextWindow=(\d+)/)[1]);
		const registered = Number(line.match(/registered=(\d+)/)[1]);
		expect(
			served,
			`served contextWindow (${served}) != registered (${registered}); pi's compaction threshold is out of sync with the CC window.\n  ${line.trim()}`,
		).toBe(registered);
	} catch (e) {
		console.log(`  RPC log:    ${RPC_LOG}`);
		console.log(`  Debug log:  ${DEBUG_LOG}`);
		throw e;
	} finally {
		await stop();
		rmSync(testAgentDir, { recursive: true, force: true });
	}
});
