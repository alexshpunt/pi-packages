/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, deleteSession, openSession } from "cc-session-io";
import { withCapturedQueries } from "../tools/verify/capture.js";
import { fixtureUser } from "../tools/verify/harness.js";

const { testBridge } = await import("../tools/verify/fixture-entry.js");

describe("syncSharedSession", () => {
	afterEach(() => {
		testBridge.resetSharedSession();
		testBridge.setPiUI(null);
	});

	// Fresh-session transcript: the system prompt arrives as a leading system message
	// (issue #106). It is prompt state, not history — a fresh session must still take
	// the clean-start path (empty priors) rather than rebuild a session file holding nothing
	// but a system head, which made --resume fail with "No conversation found".
	it("takes the clean-start path when a transcript system message precedes the first user message", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const result = testBridge.syncSharedSession([
				{ role: "system", content: "You are Claude Code.", timestamp: Date.now() },
				{ role: "user", content: "Hello", timestamp: Date.now() },
			], cwd);

			expect(result.sessionId, "a fresh session with only prompt state as priors is a clean start").toBe(null);
			expect(result.preserveSharedSession).toBe(undefined);
			expect(testBridge.getSharedSession(null), "a clean start must not create a session state").toBe(null);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// Mid-conversation tool-loadout updates land in the transcript as system messages. They must not inflate the cursor or be imported as history, or the next turn's
	// reuse check (priors >= cursor) fails and every turn rebuilds the session.
	it("keeps cursor arithmetic consistent when system messages punctuate the history", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages([
				{ role: "user", content: "Hi" },
				{ role: "assistant", content: [{ type: "text", text: "Hello." }] },
			]);
			seeded.save();
			testBridge.setSharedSession(null, { sessionId, cursor: 2, cwd });

			const result = testBridge.syncSharedSession([
				{ role: "user", content: "Hi", timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: Date.now() },
				{ role: "system", content: "", toolsAdded: [{ name: "grep", description: "", parameters: {} }], timestamp: Date.now() },
				{ role: "user", content: "Next", timestamp: Date.now() },
			], cwd);

			expect(result.sessionId, "2 priors at cursor 2 must resume, not rebuild").toBe(sessionId);
			expect(testBridge.getSharedSession(null)?.cursor, "cursor counts non-system messages only").toBe(2);
			const session = openSession({ sessionId, projectPath: cwd });
			expect(session.messages.map((m) => m.type), "the resumed session file must hold the non-system history").toStrictEqual(["user", "assistant"]);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// The branch this exercises is the guard that stops a reentrant subagent from
	// resuming — and then overwriting — the parent's session: a subagent's context
	// is shorter than the parent's cursor, so it starts fresh and the parent's
	// session is preserved. It was previously described here as the compact-summary
	// path, which cannot reach syncSharedSession at all, so the branch read as
	// covered for a case that never happens.
	it("starts a fresh session for a shorter context and preserves the parent's", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const mainSession = {
				sessionId: "11111111-1111-4111-8111-111111111111",
				cursor: 42,
				cwd,
			};
			testBridge.setSharedSession(null, mainSession);

			const result = testBridge.syncSharedSession([
				{
					role: "user",
					content: "Summarize this conversation.",
					timestamp: Date.now(),
				},
			], cwd);

			expect(result.sessionId, "a reentrant context shorter than the cursor must start a fresh Claude Code session instead of resuming the parent's").toBe(null);
			expect(result.preserveSharedSession, "the fresh session must not replace the parent's when it completes").toBe(true);
			expect(testBridge.getSharedSession(null)).toStrictEqual(mainSession);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// The rebuilt file holds one line per record, and a carried `@file` expansion
	// is an `attachment` record — which `session.messages` filters out. Counting
	// messages told every user who at-mentioned a file before switching providers
	// that their session was corrupt, and asked them to open an issue about it.
	it("does not report a count mismatch when a rebuild carries an attachment", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		const prompt = "Review @fixture.txt and remember it.";
		const notices = [];
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages(
				[
					{ role: "user", content: prompt },
					{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
				],
				{
					attachments: [{
						afterIndex: 0,
						attachment: {
							type: "file",
							filename: join(cwd, "fixture.txt"),
							content: { type: "text", file: { filePath: join(cwd, "fixture.txt"), content: "token" } },
						},
					}],
				},
			);
			seeded.save();

			testBridge.setSharedSession(null, { sessionId, cursor: 0, cwd });
			testBridge.setPiUI({ notify: (message) => notices.push(message) });
			testBridge.syncSharedSession([
				{ role: "user", content: prompt, timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: Date.now() },
				{ role: "user", content: "Now what did it say?", timestamp: Date.now() },
			], cwd);

			expect(openSession({ sessionId, projectPath: cwd }).attachments.length, "the rebuild did not carry the attachment, so this proves nothing about the count").toBe(1);
			expect(notices).toStrictEqual([]);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rebuilds history when the bridge model changes without invoking a real model", async () => {
		const observed = await withCapturedQueries({ appDir: process.cwd(), modelId: "claude-haiku-5-5", isLive: false, apiCalls: 0 }, async (harness, captures, workspace) => {
			const first = fixtureUser("Before changing models");
			const answer = await harness.turn({ messages: [first], tools: [] });
			await harness.waitForIdle();
			const id = captures[0].sessionId;
			const seeded = createSession({ sessionId: id, projectPath: workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
			seeded.importMessages([{ role: "user", content: first.content }, { role: "assistant", content: [{ type: "text", text: "fixture answer" }] }]);
			seeded.save();
			harness.runtime.markRebuildForSession(workspace.sessionId, "unit:model-change");
			const model = { ...harness.model, ...harness.runtime.MODELS.find(item => item.id === "claude-opus-4-5") };
			const result = await harness.runtime.streamClaudeAgentSdk(model, { messages: [first, answer, fixtureUser("After changing models")], tools: [] }, { sessionId: workspace.sessionId }).result();
			await harness.waitForIdle();
			const imported = openSession({ sessionId: id, projectPath: workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
			return { stopReason: result.stopReason, queryCount: captures.length, model: captures[1].options.model, sameId: captures[1].options.resume === id,
				importedModel: imported.messages.find(record => record.type === "assistant").message.model };
		});
		expect(observed.stopReason).toBe("stop");
		expect(observed.queryCount).toBe(2);
		expect(observed.sameId).toBe(true);
		expect(observed.model).toBe("claude-opus-4-5");
		expect(observed.importedModel).toBe("claude-opus-4-5");
	});
});
