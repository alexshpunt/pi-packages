#!/usr/bin/env node
// Native Pi branch summarization, end to end against Claude Code.
// cacheRetention:none routes the summary to an isolated subprocess; the bridge
// observes the completed tree rewrite without taking over the operation.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 120_000;

const harness = createRpcHarness({
	name: "branch-summary",
	args: [
		"-e", "./tests/fixtures/tree-nav-extension.ts",
		"--model", "claude-bridge/claude-haiku-5-5",
	],
	defaultTimeout: TEST_TIMEOUT,
});

describe("native branch summarization", () => {
	const { startAndWait, stop, send, promptAndWait, DEBUG_LOG } = harness;

	beforeAll(async () => { await startAndWait(); });
	afterAll(async () => { await stop(); });

	/** The command returns before the summary finishes, and a slash command emits no
	 *  agent_end, so wait for the completed native tree operation in the bridge log. */
	async function waitForLog(mark, pattern, timeout = 90_000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const slice = readFileSync(DEBUG_LOG, "utf8").slice(mark);
			if (pattern.test(slice)) return slice;
			await sleep(500);
		}
		return readFileSync(DEBUG_LOG, "utf8").slice(mark);
	}

	it("summarizes an abandoned branch without routing through the live provider", { timeout: TEST_TIMEOUT }, async () => {
		// Two turns so rewinding to the first leaves something worth summarizing.
		await promptAndWait("Reply with exactly the word ALPHA and nothing else.");
		await promptAndWait("Reply with exactly the word BETA and nothing else.");

		const mark = statSync(DEBUG_LOG).size;
		await send({ type: "prompt", message: "/rewind-summarize" });

		const completed = /session_tree: (?:marking needsRebuild|history rewritten)/;
		const log = await waitForLog(mark, completed);

		expect(log, `native summary never reached the isolated path:\n${log.slice(-1500)}`).toMatch(/provider: one-off summarizer call/);
		expect(log, `no summary was produced:\n${log.slice(-1500)}`).toMatch(/compact summary: done textLen=[1-9]\d*/);
		expect(log, `native tree navigation did not finish:\n${log.slice(-1500)}`).toMatch(completed);
		expect(log, "bridge must not take over branch summarization").not.toMatch(/session_before_tree: takeover/);
		// The whole point: it ran as its own subprocess, so the resolver that would
		// have refused pi's summarization prompt was never consulted.
		expect(log, "the summary reached the provider path").not.toMatch(/no capture for this \d+-char system prompt/);
	});
});
