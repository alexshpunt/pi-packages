/**
 * Tests for session integrity helpers:
 *   - repairToolPairing (from cc-session-io): pairs orphan tool_use blocks
 *     with synthetic tool_result so imported history never starts mid-turn.
 *   - verifyWrittenSession (mirrored from index.ts): warns if the JSONL file
 *     doesn't round-trip (missing file, record-count mismatch, sessionId drift).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repairToolPairing } from "cc-session-io";

// --- repairToolPairing ---

describe("repairToolPairing", () => {
	it("passes through a paired tool_use/tool_result", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "X", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
		];
		const repaired = repairToolPairing(msgs);
		assert.equal(repaired.length, msgs.length);
	});

	it("synthesizes a tool_result for an orphan tool_use", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "tool_use", id: "orphan", name: "X", input: {} }] },
			{ role: "user", content: "next turn" },
		];
		const repaired = repairToolPairing(msgs);
		// Prepends a synthetic tool_result block to the next user message (in-place, same count).
		assert.equal(repaired.length, msgs.length);
		const nextUser = repaired[1];
		assert.equal(nextUser.role, "user");
		assert.ok(Array.isArray(nextUser.content));
		assert.equal(nextUser.content[0].type, "tool_result");
		assert.equal(nextUser.content[0].tool_use_id, "orphan");
		assert.equal(nextUser.content[0].is_error, true);
	});

	it("empty input returns empty", () => {
		assert.deepEqual(repairToolPairing([]), []);
	});
});

// --- verifyWrittenSession (mirrored from index.ts:468) ---

// Minimal mirror: replaces the warn fan-out (debug + piUI.notify + diagDump)
// with a simple captured-messages list. Logic is 1:1 with index.ts.
function verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount, statSync, readFileSync) {
	const warnings = [];
	const warn = (msg) => warnings.push(msg);
	let st;
	try {
		st = statSync(jsonlPath);
	} catch (e) {
		warn(`file missing after save — err=${e.message}`);
		return warnings;
	}
	let content;
	try {
		content = readFileSync(jsonlPath, "utf8");
	} catch (e) {
		warn(`file unreadable — size=${st.size} err=${e.message}`);
		return warnings;
	}
	const lines = content.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length !== expectedRecordCount) {
		warn(`record count mismatch — expected=${expectedRecordCount} actual=${lines.length}`);
		return warnings;
	}
	try {
		const firstRec = JSON.parse(lines[0]);
		const lastRec = JSON.parse(lines[lines.length - 1]);
		if (firstRec.sessionId !== expectedSessionId || lastRec.sessionId !== expectedSessionId) {
			warn(`sessionId drift — expected=${expectedSessionId} first=${firstRec.sessionId} last=${lastRec.sessionId}`);
		}
	} catch (e) {
		warn(`malformed JSONL — err=${e.message}`);
	}
	return warnings;
}

describe("verifyWrittenSession", () => {
	const dir = mkdtempSync("/tmp/verify-session-");
	const path = join(dir, "session.jsonl");
	const SID = "abc-123";
	const rec = (sessionId, i) => JSON.stringify({ sessionId, idx: i });
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("no warnings when file round-trips correctly", () => {
		writeFileSync(path, [rec(SID, 0), rec(SID, 1), rec(SID, 2)].join("\n") + "\n");
		const warnings = verifyWrittenSession(path, SID, 3, statSync, readFileSync);
		assert.deepEqual(warnings, []);
	});

	it("warns when file is missing", () => {
		const missing = join(dir, "nope.jsonl");
		const warnings = verifyWrittenSession(missing, SID, 0, statSync, readFileSync);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /file missing/);
	});

	it("warns on record count mismatch", () => {
		writeFileSync(path, [rec(SID, 0), rec(SID, 1)].join("\n") + "\n");
		const warnings = verifyWrittenSession(path, SID, 5, statSync, readFileSync);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /record count mismatch.*expected=5.*actual=2/);
	});

	it("warns on sessionId drift", () => {
		writeFileSync(path, [rec(SID, 0), rec("different-sid", 1)].join("\n") + "\n");
		const warnings = verifyWrittenSession(path, SID, 2, statSync, readFileSync);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /sessionId drift/);
	});

	it("warns on malformed JSONL", () => {
		writeFileSync(path, "not json\n");
		const warnings = verifyWrittenSession(path, SID, 1, statSync, readFileSync);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /malformed JSONL/);
	});
});
