// Verifies the bridge clears its sharedSession after a pi-side /new.
//
// This already works today (the bridge subscribes to `session_start` with
// reason="new" and clears sharedSession). This is a regression test so the
// behavior stays wired up.

console.log("=== int-session-new.mjs ===");

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-5-5";

const harness = createRpcHarness({
	name: "session-new",
	args: ["--model", BRIDGE_MODEL],
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, send, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

test("a pi-side /new clears the shared session", async () => {
	await startAndWait();

	try {
		console.log("Turn 1: seed history...");
		await promptAndWait("Pick a number between 1 and 100 and remember it. Reply with just the number. Do not use the memory system.");
		console.log("Turn 2: more history...");
		await promptAndWait("Now pick a color. Reply with just the color. Do not use the memory system.");

		const NEW_MARKER_LOG = readFileSync(DEBUG_LOG, "utf8").length;

		console.log("Triggering /new...");
		await send({ type: "new_session" });

		console.log("Turn 3: prompt after /new (should be a clean start)...");
		await promptAndWait("Hello fresh session. Reply with just 'hi'.");

		const fullLog = readFileSync(DEBUG_LOG, "utf8");
		const postNewLog = fullLog.slice(NEW_MARKER_LOG);

		// The bridge logs `session_start:new: clearing ... shared sessions` when it
		// observes the event. Make sure we saw it.
		expect(postNewLog, "no `session_start:new: clearing session` marker — bridge didn't observe /new").toMatch(/session_start:new: clearing \d+ shared session/);

		// First syncResult after /new must be clean-start (sharedSession=null,
		// no prior messages on the fresh agent state).
		const syncResults = [...postNewLog.matchAll(/syncResult: path=(reuse|rebuild|clean-start)/g)].map((m) => m[1]);
		console.log(`  Post-/new syncResults: ${JSON.stringify(syncResults)}`);
		expect(syncResults.length, "no syncResult markers after /new (Turn 3 didn't reach the provider?)").toBeGreaterThan(0);
		expect(
			syncResults[0],
			`bridge took ${syncResults[0]} path after /new — expected clean-start.\n` +
			`       sharedSession should be cleared by the session_start:new handler.`,
		).toBe("clean-start");
	} catch (e) {
		console.log(`  RPC log:    ${RPC_LOG}`);
		console.log(`  Debug log:  ${DEBUG_LOG}`);
		throw e;
	} finally {
		await stop();
	}
});
