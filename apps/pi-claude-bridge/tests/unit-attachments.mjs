#!/usr/bin/env node
// Unit tests for carrying CC attachments across a rebuild (attachments.ts).

import { describe, expect, it } from "vitest";
import { collectCarriedAttachments, placeCarriedAttachments } from "../src/attachments.js";

const user = (uuid, text) => ({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] } });
const toolResultUser = (uuid) => ({
	type: "user", uuid,
	message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
});
const attach = (uuid, parentUuid, type, filename) => ({
	type: "attachment", uuid, parentUuid, attachment: { type, filename },
});

describe("collectCarriedAttachments", () => {
	it("keeps content-bearing kinds and drops the ones CC regenerates", () => {
		const carried = collectCarriedAttachments([
			user("u1", "review @a.js"),
			attach("a1", "u1", "file", "/a.js"),
			attach("a2", "u1", "skill_listing"),
			attach("a3", "u1", "task_reminder"),
			attach("a4", "u1", "edited_text_file", "/b.js"),
		]);
		// edited_text_file is deliberately not carried: the edit is already in pi's
		// history as a tool call; supporting tool-result anchors does not add this
		// duplicate snapshot kind to the carry policy.
		expect(carried.map((c) => c.attachment.filename)).toStrictEqual(["/a.js"]);
	});

	it("counts ordinals over prompts only, skipping tool-result user records", () => {
		const carried = collectCarriedAttachments([
			user("u1", "first"),
			toolResultUser("u2"),
			user("u3", "review @a.js"),
			attach("a1", "u3", "file", "/a.js"),
		]);
		expect(carried[0].userOrdinal).toBe(1);
		expect(carried[0].parentText).toBe("review @a.js");
	});

	it("ignores an attachment whose parent cannot be resolved", () => {
		const carried = collectCarriedAttachments([
			user("u1", "first"),
			attach("a1", "missing-uuid", "file", "/a.js"),
		]);
		expect(carried.length).toBe(0);
	});
});

describe("placeCarriedAttachments", () => {
	const carried = [{ attachment: { type: "file", filename: "/a.js" }, userOrdinal: 1, parentText: "review @a.js" }];

	it("resolves the ordinal to an index in the array being imported", () => {
		const { attachments, skipped } = placeCarriedAttachments(carried, [
			{ role: "user", content: "first" },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: [{ type: "text", text: "review @a.js" }] },
		]);
		expect(skipped.length).toBe(0);
		expect(attachments).toStrictEqual([{ afterIndex: 2, attachment: carried[0].attachment }]);
	});

	it("drops it when that prompt changed rather than guessing", () => {
		const { attachments, skipped } = placeCarriedAttachments(carried, [
			{ role: "user", content: "first" },
			{ role: "user", content: "something else entirely" },
		]);
		expect(attachments.length).toBe(0);
		expect(skipped[0]).toMatch(/changed/);
	});

	it("drops it when history no longer reaches that prompt", () => {
		const { attachments, skipped } = placeCarriedAttachments(carried, [{ role: "user", content: "first" }]);
		expect(attachments.length).toBe(0);
		expect(skipped[0]).toMatch(/no longer in history/);
	});
});

describe("attachments chained to other attachments", () => {
	it("inherits the ordinal up a run so the whole run keys to one prompt", () => {
		const carried = collectCarriedAttachments([
			user("u1", "first"),
			user("u2", "edit the files"),
			attach("a1", "u2", "file", "/a.js"),
			attach("a2", "a1", "edited_text_file", "/b.js"),
			attach("a3", "a2", "file", "/c.js"),
		]);
		// The uncarried kind still has to resolve, or the run breaks after it.
		expect(carried.map((c) => c.attachment.filename)).toStrictEqual(["/a.js", "/c.js"]);
		expect(carried.map((c) => c.userOrdinal)).toStrictEqual([1, 1]);
	});

	it("resolves through a kind it does not carry", () => {
		const carried = collectCarriedAttachments([
			user("u1", "go"),
			attach("a1", "u1", "skill_listing"),
			attach("a2", "a1", "file", "/a.js"),
		]);
		expect(carried.map((c) => c.attachment.filename)).toStrictEqual(["/a.js"]);
		expect(carried[0].userOrdinal).toBe(0);
	});
});

describe("session context anchors", () => {
	it("keeps every declared session-context kind at its original prompt", () => {
		const kinds = ["environment", "model", "output_style_instructions", "total_tokens_reminder", "output_style", "session_context", "date", "credential_org", "instructions"];
		const records = [user("u1", "original prompt"), ...kinds.map((kind, i) => attach(`a${i}`, i ? `a${i - 1}` : "u1", kind))];
		const carried = collectCarriedAttachments(records);
		expect(carried.map(item => item.attachment.type)).toStrictEqual(kinds);
		const placed = placeCarriedAttachments(carried, [{ role: "user", content: "original prompt" }, { role: "assistant", content: "answer" }, { role: "user", content: "next prompt" }]);
		expect(placed.skipped.length).toBe(0);
		expect(placed.attachments.map(item => item.afterIndex)).toStrictEqual(kinds.map(() => 0));
	});
	it("anchors chained reminders by tool-use id even inside a parallel result group", () => {
		const carried = collectCarriedAttachments([
			user("u1", "prompt"), toolResultUser("r1"), attach("a1", "r1", "total_tokens_reminder"), attach("a2", "a1", "session_context"),
		]);
		expect(carried.map(item => item.toolUseId)).toStrictEqual(["t1", "t1"]);
		const placed = placeCarriedAttachments(carried, [
			{ role: "assistant", content: [] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "other", content: "other" }, { type: "tool_result", tool_use_id: "t1", content: "ok" }] },
		]);
		expect(placed.skipped.length).toBe(0);
		expect(placed.attachments.map(item => item.afterIndex)).toStrictEqual([1, 1]);
		const missing = placeCarriedAttachments(carried, [{ role: "user", content: "not the old tool result" }]);
		expect(missing.attachments.length).toBe(0);
		expect(missing.skipped.length).toBe(2);
	});
	it("does not attach old session context to a changed prompt", () => {
		const carried = collectCarriedAttachments([user("u1", "old prompt"), attach("a1", "u1", "instructions")]);
		const placed = placeCarriedAttachments(carried, [{ role: "user", content: "new prompt" }]);
		expect(placed.attachments).toStrictEqual([]);
		expect(placed.skipped[0]).toMatch(/changed/);
	});
});
