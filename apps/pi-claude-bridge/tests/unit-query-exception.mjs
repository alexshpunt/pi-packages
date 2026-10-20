import { it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createSession } from "cc-session-io";
import { createHarness, fixtureUser } from "../tools/verify/harness.js";
import { withWorkspace } from "../tools/verify/workspace.js";

async function exceptionThenRetry(isAborted) {
	return withWorkspace(false, async workspace => {
		const harness = createHarness(workspace);
		const runtime = harness.runtime;
		const session = createSession({ projectPath: workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR, model: harness.cliModel });
		session.importMessages([{ role: "user", content: "Prior prompt" }, { role: "assistant", content: [{ type: "text", text: "Prior answer" }] }]);
		session.save();
		const siblingId = randomUUID();
		const sibling = { sessionId: randomUUID(), cursor: 8, cwd: workspace.cwd, piSessionId: siblingId };
		runtime.setSessionStateFor(workspace.sessionId, { sessionId: session.sessionId, cursor: 2, cwd: workspace.cwd, piSessionId: workspace.sessionId });
		runtime.setSessionStateFor(siblingId, sibling);
		const logs = [];
		runtime.debug = (...values) => logs.push(values.map(String).join(" "));
		const resumeIds = [];
		let shouldThrow = true;
		let closeCount = 0;
		runtime.setQuery(input => {
			resumeIds.push(input.options.resume);
			let source;
			const iterator = (async function* () {
				source = input.prompt[Symbol.asyncIterator]();
				await source.next();
				yield { type: "system", subtype: "init", session_id: input.options.resume };
				if (shouldThrow) throw new Error("Query transport ended");
				yield { type: "assistant", message: { id: "msg_retry", content: [{ type: "text", text: "Continued" }] } };
				yield { type: "result", subtype: "success", is_error: false, result: "Continued" };
			})();
			return Object.assign(iterator, { interrupt: async () => {}, close() { closeCount++; void source?.return?.().catch(() => {}); } });
		});
		try {
			const messages = [fixtureUser("Prior prompt"), {
				role: "assistant", content: [{ type: "text", text: "Prior answer" }], api: "claude-bridge", provider: "claude-bridge",
				model: harness.model.id, stopReason: "stop", timestamp: 0,
			}, fixtureUser("Retry this prompt")];
			const failed = await harness.turn({ messages, tools: [] }, isAborted ? { signal: AbortSignal.abort() } : {});
			await harness.waitForIdle();
			const afterFailure = runtime.sessionStateFor(workspace.sessionId);
			shouldThrow = false;
			const retried = await harness.turn({ messages, tools: [] });
			await harness.waitForIdle();
			return {
				originalId: session.sessionId, afterFailure, afterRetry: runtime.sessionStateFor(workspace.sessionId),
				failedReason: failed.stopReason, retryReason: retried.stopReason,
				siblingUnchanged: runtime.sessionStateFor(siblingId) === sibling,
				resumeIds, logs, closeCount, previousFileExists: existsSync(session.jsonlPath),
			};
		} finally { await harness.close(); }
	});
}

it("keeps the owning mirror after an exception and rebuilds the retry at the same CC id", async () => {
	const result = await exceptionThenRetry(false);
	assert.equal(result.failedReason, "error");
	assert.equal(result.afterFailure?.sessionId, result.originalId);
	assert.equal(result.afterFailure?.cursor, 2);
	assert.equal(result.afterFailure?.needsRebuild, true);
	assert.notEqual(result.afterFailure?.forceRotate, true);
	assert.equal(result.siblingUnchanged, true);
	assert.equal(result.retryReason, "stop");
	assert.equal(result.afterRetry.sessionId, result.originalId);
	assert.deepEqual(result.resumeIds, [result.originalId, result.originalId]);
	assert.ok(result.logs.some(line => /syncResult: path=rebuild .* preserved$/.test(line)));
	assert.equal(result.previousFileExists, true);
	assert.ok(result.closeCount >= 2);
});

it("still marks aborted queries for rotation and preserves their old file", async () => {
	const result = await exceptionThenRetry(true);
	assert.equal(result.failedReason, "aborted");
	assert.equal(result.afterFailure?.sessionId, result.originalId);
	assert.equal(result.afterFailure?.needsRebuild, true);
	assert.equal(result.afterFailure?.forceRotate, true);
	assert.notEqual(result.afterRetry.sessionId, result.originalId);
	assert.equal(result.resumeIds[1], result.afterRetry.sessionId);
	assert.ok(result.logs.some(line => /syncResult: path=rebuild .* rotated-post-abort$/.test(line)));
	assert.equal(result.siblingUnchanged, true);
	assert.equal(result.previousFileExists, true);
});
