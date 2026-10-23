/**
 * Tests for session integrity helpers:
 *   - repairToolPairing (from cc-session-io): pairs orphan tool_use blocks
 *     with synthetic tool_result so imported history never starts mid-turn.
 *   - verifyWrittenSession (from features/session/verify.ts): warns if the JSONL file
 *     doesn't round-trip (missing file, record-count mismatch, sessionId drift).
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairToolPairing } from "cc-session-io";
import { verifyWrittenSession } from "../src/features/session/verify.js";

// --- repairToolPairing ---

describe("repairToolPairing", () => {
	it("passes through a paired tool_use/tool_result", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "X", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
		];
		const repaired = repairToolPairing(msgs);
		expect(repaired.length).toBe(msgs.length);
	});

	it("synthesizes a tool_result for an orphan tool_use", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "tool_use", id: "orphan", name: "X", input: {} }] },
			{ role: "user", content: "next turn" },
		];
		const repaired = repairToolPairing(msgs);
		// Prepends a synthetic tool_result block to the next user message (in-place, same count).
		expect(repaired.length).toBe(msgs.length);
		const nextUser = repaired[1];
		expect(nextUser.role).toBe("user");
		expect(Array.isArray(nextUser.content)).toBeTruthy();
		expect(nextUser.content[0].type).toBe("tool_result");
		expect(nextUser.content[0].tool_use_id).toBe("orphan");
		expect(nextUser.content[0].is_error).toBe(true);
	});

	it("empty input returns empty", () => {
		expect(repairToolPairing([])).toStrictEqual([]);
	});
});

describe("verifyWrittenSession", () => {
	const dir = mkdtempSync(join(tmpdir(), "verify-session-"));
	const path = join(dir, "session.jsonl");
	const SID = "abc-123";
	const rec = (sessionId, i) => JSON.stringify({ sessionId, idx: i });
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("no warnings when file round-trips correctly", () => {
		writeFileSync(path, [rec(SID, 0), rec(SID, 1), rec(SID, 2)].join("\n") + "\n");
		expect(verifyWrittenSession(path, SID, 3)).toStrictEqual([]);
	});

	it("warns when file is missing", () => {
		const missing = join(dir, "nope.jsonl");
		const warnings = verifyWrittenSession(missing, SID, 0);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toMatch(/file missing/);
	});

	it("warns on record count mismatch", () => {
		writeFileSync(path, [rec(SID, 0), rec(SID, 1)].join("\n") + "\n");
		const warnings = verifyWrittenSession(path, SID, 5);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toMatch(/record count mismatch.*expected=5.*actual=2/);
	});

	it("warns on sessionId drift", () => {
		writeFileSync(path, [rec(SID, 0), rec("different-sid", 1)].join("\n") + "\n");
		const warnings = verifyWrittenSession(path, SID, 2);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toMatch(/sessionId drift/);
	});

	it("warns on malformed JSONL", () => {
		writeFileSync(path, "not json\n");
		const warnings = verifyWrittenSession(path, SID, 1);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toMatch(/malformed JSONL/);
	});
});
