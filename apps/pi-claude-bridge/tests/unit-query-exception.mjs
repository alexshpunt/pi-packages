import { expect, it } from "vitest";
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
				failedReason: failed.stopReason, failedMessage: failed.errorMessage, retryReason: retried.stopReason,
				siblingUnchanged: runtime.sessionStateFor(siblingId) === sibling,
				resumeIds, logs, closeCount, previousFileExists: existsSync(session.jsonlPath),
			};
		} finally { await harness.close(); }
	});
}

it("keeps the owning mirror after an exception and rebuilds the retry at the same CC id", async () => {
	const result = await exceptionThenRetry(false);
	expect(result.failedReason).toBe("error");
	expect(result.failedMessage).toBe("Query transport ended");
	expect(result.afterFailure?.sessionId).toBe(result.originalId);
	expect(result.afterFailure?.cursor).toBe(2);
	expect(result.afterFailure?.needsRebuild).toBe(true);
	expect(result.afterFailure?.forceRotate).not.toBe(true);
	expect(result.siblingUnchanged).toBe(true);
	expect(result.retryReason).toBe("stop");
	expect(result.afterRetry.sessionId).toBe(result.originalId);
	expect(result.resumeIds).toStrictEqual([result.originalId, result.originalId]);
	expect(result.logs.some(line => /syncResult: path=rebuild .* preserved$/.test(line))).toBeTruthy();
	expect(result.previousFileExists).toBe(true);
	expect(result.closeCount >= 2).toBeTruthy();
});

it("still marks aborted queries for rotation and preserves their old file", async () => {
	const result = await exceptionThenRetry(true);
	expect(result.failedReason).toBe("aborted");
	expect(result.failedMessage).toBe("Operation aborted");
	expect(result.afterFailure?.sessionId).toBe(result.originalId);
	expect(result.afterFailure?.needsRebuild).toBe(true);
	expect(result.afterFailure?.forceRotate).toBe(true);
	expect(result.afterRetry.sessionId).not.toBe(result.originalId);
	expect(result.resumeIds[1]).toBe(result.afterRetry.sessionId);
	expect(result.logs.some(line => /syncResult: path=rebuild .* rotated-post-abort$/.test(line))).toBeTruthy();
	expect(result.siblingUnchanged).toBe(true);
	expect(result.previousFileExists).toBe(true);
});
