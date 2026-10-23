import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSession, openSession } from "cc-session-io";
import { convertPiMessages } from "../src/features/session/convert.js";
import { deleteSessionKeepingToolResults } from "../src/features/session/service.js";
import { applyCarriedToolResults, collectCarriedToolResults, readSavedOutput } from "../src/features/session/tool-result-carry.js";
import { createHarness, fixtureUser } from "../tools/verify/harness.js";
import { withWorkspace } from "../tools/verify/workspace.js";
import { VERIFICATION_PNG_BASE64 } from "../tools/verify/fixtures/image.js";

const image = () => ({ type: "image", source: { type: "base64", media_type: "image/png", data: VERIFICATION_PNG_BASE64 } });
const text = value => ({ type: "text", text: value });
const marker = path => text(`[Image: source: ${path}]`);
const notice = path => `Error: result (92160 characters) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: Plain text\n`;
const record = (id, content, extra = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, ...extra });
const converted = (id, content, isError = false) => [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }];

function withFixture(run) {
	const temporary = mkdtempSync(join(tmpdir(), "bridge-tool-carry-"));
	const root = join(temporary, "project");
	const sessionId = randomUUID();
	const results = join(root, sessionId, "tool-results");
	mkdirSync(results, { recursive: true });
	try { return run({ temporary, root, sessionId, results }); }
	finally { rmSync(temporary, { recursive: true, force: true }); }
}

it("uses actual user results, never api-request-blob or sidechain copies", () => withFixture(({ root, results }) => {
	const content = [image(), marker(join(results, "image.png"))];
	const copy = [image(), marker(join(results, "wrong.png"))];
	const carried = collectCarriedToolResults([null, 1, record("i", content), record("i", copy, { type: "api-request-blob" }), record("i", copy, { isSidechain: true })]);
	expect(carried.size).toBe(1);
	const messages = converted("i", [image()]);
	expect(applyCarriedToolResults(messages, carried, root)).toStrictEqual(["i"]);
	expect(messages[0].content[0].content).toStrictEqual(content);
}));

it("lets a later ordinary result supersede an earlier carried form of the same id", () => withFixture(({ results }) => {
	const carried = collectCarriedToolResults([record("i", [image(), marker(join(results, "image.png"))]), record("i", "later ordinary result")]);
	expect(carried.has("i")).toBe(false);
}));

it("lazily reads only relevant saved results and retains the live oversized notice", () => withFixture(({ root, results }) => {
	const path = join(results, "large.txt");
	const body = "full output\n한글\n";
	writeFileSync(path, body);
	const native = notice(path);
	const carried = collectCarriedToolResults([record("large", native), record("unused", notice(join(results, "missing.txt")))]);
	expect(carried.size, "collecting descriptors must not depend on opening unused files").toBe(2);
	const messages = converted("large", [text(body)]);
	expect(applyCarriedToolResults(messages, carried, root)).toStrictEqual(["large"]);
	expect(messages[0].content[0].content).toBe(native);
	expect(messages[0].content[0].tool_use_id).toBe("large");
	expect(Object.hasOwn(messages[0].content[0], "is_error")).toBe(false);
}));

it("matches saved JSON MCP image/text blocks against converted Anthropic blocks", () => withFixture(({ root, results }) => {
	const path = join(results, "large.json");
	writeFileSync(path, JSON.stringify([text("full"), { type: "image", data: VERIFICATION_PNG_BASE64, mimeType: "image/png" }]));
	const native = `<persisted-output>\nOutput too large (32 KB). Full output saved to: ${path}\n\nPreview\n</persisted-output>`;
	const messages = converted("json", [text("full"), image()]);
	expect(applyCarriedToolResults(messages, collectCarriedToolResults([record("json", native)]), root)).toStrictEqual(["json"]);
	expect(messages[0].content[0].content).toBe(native);
}));

it("does not replace Pi's edited text or changed error state", () => withFixture(({ root, results }) => {
	const path = join(results, "large.txt");
	writeFileSync(path, "original");
	const carried = collectCarriedToolResults([record("t", notice(path))]);
	for (const [body, isError] of [["edited", false], ["original", true]]) {
		const messages = converted("t", [text(body)], isError);
		const before = structuredClone(messages);
		expect(applyCarriedToolResults(messages, carried, root)).toStrictEqual([]);
		expect(messages).toStrictEqual(before);
	}
}));

it("preserves image markers only while the image's bytes and MIME type still match", () => withFixture(({ root, results }) => {
	const path = join(results, "image.png");
	writeFileSync(path, Buffer.from(VERIFICATION_PNG_BASE64, "base64"));
	const native = [text("caption"), image(), marker(path)];
	const carried = collectCarriedToolResults([record("i", native)]);
	const messages = converted("i", [text("caption"), image()]);
	expect(applyCarriedToolResults(messages, carried, root)).toStrictEqual(["i"]);
	expect(messages[0].content[0].content).toStrictEqual(native);
	for (const patch of [{ data: "CHANGED" }, { media_type: "image/jpeg" }]) {
		const changed = image(); Object.assign(changed.source, patch);
		const edited = converted("i", [text("caption"), changed]);
		const before = structuredClone(edited);
		expect(applyCarriedToolResults(edited, carried, root)).toStrictEqual([]);
		expect(edited).toStrictEqual(before);
	}
	rmSync(path);
	expect(applyCarriedToolResults(converted("i", [text("caption"), image()]), carried, root), "inline data is complete even when an image copy is missing").toStrictEqual(["i"]);
}));

it("does not confuse ordinary marker-looking Pi text with generated image metadata", () => withFixture(({ root, results }) => {
	const ordinary = text("[Image: source: literal user text]");
	const native = [image(), marker(join(results, "image.png")), ordinary];
	const carried = collectCarriedToolResults([record("i", native)]);
	expect(applyCarriedToolResults(converted("i", [image(), ordinary]), carried, root)).toStrictEqual(["i"]);
	expect(applyCarriedToolResults(converted("i", [image()]), carried, root), "removing Pi text must win over the older native content").toStrictEqual([]);
}));

it("falls back for missing files, invalid JSON and unsupported saved block types", () => withFixture(({ root, results }) => {
	const path = join(results, "result.json");
	for (const value of [undefined, "not JSON", "{}", '[{"type":"resource"}]']) {
		if (value === undefined) rmSync(path, { force: true }); else writeFileSync(path, value);
		const messages = converted("t", "Pi result");
		expect(applyCarriedToolResults(messages, collectCarriedToolResults([record("t", notice(path))]), root)).toStrictEqual([]);
		expect(messages[0].content[0].content).toBe("Pi result");
	}
}));

it("rejects other projects, non-tool directories and relative paths", () => withFixture(({ root, sessionId, results, temporary }) => {
	const outside = join(temporary, "other", sessionId, "tool-results", "data.txt");
	mkdirSync(dirname(outside), { recursive: true }); writeFileSync(outside, "outside");
	const metadata = join(root, sessionId, "metadata.txt"); writeFileSync(metadata, "metadata");
	for (const path of [outside, metadata, "relative.txt", join(results, "..", "metadata.txt")]) expect(readSavedOutput(root, path)).toBe(undefined);
	const messages = converted("i", [image()]);
	expect(applyCarriedToolResults(messages, collectCarriedToolResults([record("i", [image(), marker(outside)])]), root)).toStrictEqual([]);
}));

it("rejects symlinks at the file, tool-results, session and project boundaries", () => {
	for (const level of ["file", "results", "session", "project"]) withFixture(({ temporary, root, sessionId, results }) => {
		const targetRoot = join(temporary, "other-project");
		const targetResults = join(targetRoot, sessionId, "tool-results");
		mkdirSync(targetResults, { recursive: true }); writeFileSync(join(targetResults, "data.txt"), "outside");
		const local = join(results, "data.txt");
		const from = level === "file" ? local : level === "results" ? results : level === "session" ? dirname(results) : root;
		const target = level === "file" ? join(targetResults, "data.txt") : level === "results" ? targetResults : level === "session" ? dirname(targetResults) : targetRoot;
		rmSync(from, { recursive: true, force: true }); symlinkSync(target, from);
		expect(readSavedOutput(root, local), level).toBe(undefined);
	});
});

it("reads the exact 32 MiB boundary, rejects one byte more and rejects directories", () => withFixture(({ root, results }) => {
	const path = join(results, "bounded.txt");
	const limit = 32 * 1024 * 1024;
	writeFileSync(path, Buffer.alloc(limit, 0x61));
	const output = readSavedOutput(root, path);
	expect(output.length).toBe(limit);
	expect(output[0]).toBe("a"); expect(output.at(-1)).toBe("a");
	appendFileSync(path, "b");
	expect(readSavedOutput(root, path)).toBe(undefined);
	const directory = join(results, "directory"); mkdirSync(directory);
	expect(readSavedOutput(root, directory)).toBe(undefined);
}));

it("clears auxiliary state without following companion or result-directory symlinks", () => withFixture(({ temporary, root, sessionId, results }) => {
	const path = join(root, `${sessionId}.jsonl`);
	const outside = join(temporary, "outside"); mkdirSync(outside); writeFileSync(join(outside, "keep"), "keep");
	writeFileSync(path, "old");
	rmSync(results, { recursive: true }); symlinkSync(outside, results);
	deleteSessionKeepingToolResults(path);
	expect(existsSync(path)).toBe(false); expect(existsSync(results)).toBe(false);
	expect(readFileSync(join(outside, "keep"), "utf8")).toBe("keep");
	rmSync(dirname(results), { recursive: true }); symlinkSync(outside, dirname(results));
	writeFileSync(path, "old"); deleteSessionKeepingToolResults(path);
	expect(existsSync(dirname(results))).toBe(false);
	expect(readFileSync(join(outside, "keep"), "utf8")).toBe("keep");
}));

for (const shouldRotate of [false, true]) it(`production sync preserves image and large-result content/files with rotation=${shouldRotate}`, async () => {
	await withWorkspace(false, async workspace => {
		const harness = createHarness(workspace);
		try {
			const prior = [fixtureUser("seed"),
				{ role: "assistant", provider: "claude-bridge", model: harness.model.id, content: [
					{ type: "toolCall", id: "image", name: "image", arguments: {} }, { type: "toolCall", id: "large", name: "large", arguments: {} }], timestamp: 1 },
				{ role: "toolResult", toolCallId: "image", toolName: "image", content: [{ type: "image", data: VERIFICATION_PNG_BASE64, mimeType: "image/png" }], timestamp: 2 },
				{ role: "toolResult", toolCallId: "large", toolName: "large", content: [text("large".repeat(18_432))], timestamp: 3 },
				{ role: "assistant", provider: "claude-bridge", model: harness.model.id, content: [text("done")], timestamp: 4 }];
			const seeded = createSession({ projectPath: workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR, model: harness.model.id });
			const oldId = seeded.sessionId;
			const results = join(dirname(seeded.jsonlPath), oldId, "tool-results"); mkdirSync(results, { recursive: true });
			const imagePath = join(results, "image.png"), largePath = join(results, "large.txt");
			writeFileSync(imagePath, Buffer.from(VERIFICATION_PNG_BASE64, "base64"));
			writeFileSync(largePath, prior[3].content[0].text);
			const nativeImage = [image(), marker(imagePath)], nativeLarge = notice(largePath);
			const { anthropicMessages } = convertPiMessages(prior);
			for (const message of anthropicMessages) if (Array.isArray(message.content)) for (const block of message.content) {
				if (block.type === "tool_result") block.content = block.tool_use_id === "image" ? nativeImage : nativeLarge;
			}
			seeded.importMessages(anthropicMessages); seeded.save();
			appendFileSync(seeded.jsonlPath, JSON.stringify({ type: "api-request-blob", message: { content: [{ type: "tool_result", tool_use_id: "large", content: "not a live result" }] } }) + "\n");
			const auxiliary = join(dirname(results), "auxiliary.json"); writeFileSync(auxiliary, "old");
			const oldBytes = readFileSync(seeded.jsonlPath);
			harness.runtime.setSessionStateFor(workspace.sessionId, { sessionId: oldId, cwd: workspace.cwd, cursor: 0, needsRebuild: true, forceRotate: shouldRotate });
			const synced = harness.runtime.syncSharedSession([...prior, fixtureUser("after")], workspace.cwd, undefined, harness.model.id, workspace.sessionId);
			expect(synced.sessionId === oldId).toBe(!shouldRotate);
			const rebuilt = openSession({ sessionId: synced.sessionId, projectPath: workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
			const blocks = rebuilt.messages.flatMap(record => Array.isArray(record.message.content) ? record.message.content.filter(block => block.type === "tool_result") : []);
			expect(blocks.map(block => block.tool_use_id)).toStrictEqual(["image", "large"]);
			expect(blocks[0].content).toStrictEqual(nativeImage); expect(blocks[1].content).toBe(nativeLarge);
			expect(Object.keys(blocks[0])).toStrictEqual(["tool_use_id", "type", "content"]);
			expect(readFileSync(imagePath)).toStrictEqual(Buffer.from(VERIFICATION_PNG_BASE64, "base64"));
			expect(readFileSync(largePath, "utf8")).toBe(prior[3].content[0].text);
			expect(existsSync(auxiliary)).toBe(shouldRotate);
			expect(rebuilt.records.some(record => record.type === "api-request-blob")).toBe(false);
			expect(rebuilt.messages.filter(record => record.type === "assistant").every(record => record.message.id.startsWith("msg_syn_") && record.requestId.startsWith("req_syn_"))).toBeTruthy();
			if (shouldRotate) expect(readFileSync(seeded.jsonlPath)).toStrictEqual(oldBytes);
		} finally { await harness.close(); }
	});
});
