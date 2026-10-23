import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { testBridge } = await import("../tools/verify/fixture-entry.js");

describe("extractUserPromptBlocks", () => {
	it("keeps images and text from the trailing run of user messages", () => {
		const blocks = testBridge.extractUserPromptBlocks([
			{ role: "user", content: [
				{ type: "text", text: "describe this" },
				{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
			] },
			{ role: "user", content: "(attachment preview: [#image 1])" },
		]);

		expect(blocks).toStrictEqual([
			{ type: "text", text: "describe this" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
			{ type: "text", text: "(attachment preview: [#image 1])" },
		]);
	});

	it("does not reach past the current user turn", () => {
		const blocks = testBridge.extractUserPromptBlocks([
			{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "b2xk" }] },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
			{ role: "user", content: "next turn" },
		]);

		expect(blocks).toBe(null);
	});

	// Data-less image blocks occur in the wild; the skip guard has to run before
	// the debug line that reads .length off the missing field.
	it("skips malformed image blocks instead of throwing", () => {
		const blocks = testBridge.extractUserPromptBlocks([
			{ role: "user", content: [
				{ type: "text", text: "look" },
				{ type: "image", mimeType: "image/png" },
				{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
			] },
		]);

		expect(blocks).toStrictEqual([
			{ type: "text", text: "look" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
		]);
	});

	// Off-type content is a contract violation, so it should fail loudly — and
	// name the shape, since the culprit is usually another extension.
	it("throws a legible error on off-type content", () => {
		expect(() => testBridge.extractUserPromptBlocks([{ role: "user", content: undefined }])).toThrow(/content must be a string or block array, got undefined/);
	});
});

describe("history/prompt split", () => {
	afterEach(() => testBridge.resetSharedSession());

	// The turn boundary is computed once and both halves derive from it, so a
	// message can never be replayed as history *and* resent as the prompt.
	it("does not replay the current turn as session history", () => {
		const cwd = mkdtempSync(join(tmpdir(), "turn-split-"));
		const claudeDir = mkdtempSync(join(tmpdir(), "turn-split-cfg-"));
		const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = claudeDir;
		try {
			const messages = [
				{ role: "user", content: "earlier question", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "earlier answer" }], timestamp: 2 },
				// The current turn: real image-bearing message plus an extension's
				// trailing display-only message (issue #34).
				{ role: "user", content: [
					{ type: "text", text: "describe this" },
					{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
				], timestamp: 3 },
				{ role: "user", content: "(attachment preview: [#image 1])", timestamp: 4 },
			];

			const { sessionId } = testBridge.syncSharedSession(messages, cwd);
			// readdir rather than fs.globSync — the latter is Node 22+, and engines allows 20.
			const projectsDir = join(claudeDir, "projects");
			const [projectDir] = readdirSync(projectsDir);
			expect(projectDir, "syncSharedSession should have written a session file").toBeTruthy();
			const history = readFileSync(join(projectsDir, projectDir, `${sessionId}.jsonl`), "utf8");
			const prompt = JSON.stringify(testBridge.extractUserPromptBlocks(messages));

			expect(prompt, "the image-bearing message belongs in the prompt").toMatch(/describe this/);
			expect(history, "and must not also be replayed as history").not.toMatch(/describe this/);
			expect(history, "genuinely prior turns still become history").toMatch(/earlier question/);
		} finally {
			// Assigning undefined would set the literal string "undefined".
			if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
			rmSync(cwd, { recursive: true, force: true });
			rmSync(claudeDir, { recursive: true, force: true });
		}
	});
});
