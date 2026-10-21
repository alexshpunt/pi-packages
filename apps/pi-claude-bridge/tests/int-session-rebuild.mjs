#!/usr/bin/env node
// Integration tests for session-rebuild mechanics.
//
// syncSharedSession's REBUILD path wipes the existing session file and
// rewrites it at the same path, preserving the sessionId across rebuilds.
// These tests validate the primitives that path depends on:
//
//   1. clear+replace                — openSession + clear + re-add + save
//   2. deleteSession + createSession — preserves sessionId across a full
//                                      delete/recreate cycle (the strategy
//                                      syncSharedSession actually uses)
//   3. rebuild after CC tool use    — CC appends tool_use/tool_result records
//                                      to the session file during execution;
//                                      a subsequent rebuild must wipe them
//                                      cleanly without orphan tool refs
//                                      confusing the next --resume
//   4. companion dir wipe           — deleteSession must remove the sibling
//                                      <sid>/ directory (subagents/,
//                                      tool-results/ under CC v2.1.x)
//
// CC behavior verified: --resume reads the JSONL fresh from disk on every
// call (no in-process UUID caching), so the clear+rewrite pattern is safe.
//
// Requires: ANTHROPIC_API_KEY or CC logged in.

import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSession, openSession, deleteSession } from "cc-session-io";
import { query } from "@anthropic-ai/claude-agent-sdk";

const CWD = process.cwd();
const MODEL = "claude-haiku-5-5";

async function drain(q) {
	let out = "";
	for await (const m of q) {
		if (m.type === "assistant") {
			for (const block of m.message?.content ?? []) {
				if (block.type === "text") out += block.text;
			}
		}
	}
	return out.trim();
}

function seedTextSession(sid, token) {
	const s = createSession({
		sessionId: sid,
		projectPath: CWD,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		model: MODEL,
	});
	s.addUserMessage(`Please remember: the token is ${token}.`);
	s.addAssistantMessage([{ type: "text", text: `Got it, the token is ${token}.` }]);
	s.save();
	return s;
}

function countRecords(jsonlPath) {
	if (!existsSync(jsonlPath)) return { total: 0, byType: {}, toolUse: 0, toolResult: 0 };
	const content = readFileSync(jsonlPath, "utf8");
	const lines = content.trim().split("\n").filter(Boolean);
	const byType = {};
	let toolUse = 0;
	let toolResult = 0;
	for (const line of lines) {
		try {
			const rec = JSON.parse(line);
			byType[rec.type] = (byType[rec.type] || 0) + 1;
			if (Array.isArray(rec.message?.content)) {
				for (const block of rec.message.content) {
					if (block.type === "tool_use") toolUse++;
					if (block.type === "tool_result") toolResult++;
				}
			}
		} catch { /* skip malformed */ }
	}
	return { total: lines.length, byType, toolUse, toolResult };
}

async function askToken(sid) {
	return drain(query({
		prompt: "What token did I ask you to remember? Reply with just the word.",
		options: { resume: sid, model: MODEL, cwd: CWD, permissionMode: "bypassPermissions" },
	}));
}

test("openSession + clear + re-add: CC resolves the replaced content", { timeout: 120_000 }, async () => {
	const sid = randomUUID();
	seedTextSession(sid, "FOO");

	const r1 = await askToken(sid);
	expect(r1, `expected FOO on first resume, got: ${r1}`).toMatch(/foo/i);

	const s2 = openSession({ sessionId: sid, projectPath: CWD, claudeDir: process.env.CLAUDE_CONFIG_DIR });
	s2.clear();
	s2.addUserMessage("Please remember: the token is BAR.");
	s2.addAssistantMessage([{ type: "text", text: "Got it, the token is BAR." }]);
	s2.save();

	const r2 = await askToken(sid);
	expect(r2, `expected BAR after clear+replace, got: ${r2}`).toMatch(/bar/i);
	expect(r2, `stale FOO returned — CC may be caching by UUID: ${r2}`).not.toMatch(/foo/i);
});

test("deleteSession + createSession({sessionId}): sessionId preserved across full wipe", { timeout: 120_000 }, async () => {
	const sid = randomUUID();
	seedTextSession(sid, "ALPHA");

	const r1 = await askToken(sid);
	expect(r1, `expected ALPHA on first resume, got: ${r1}`).toMatch(/alpha/i);

	deleteSession(sid, CWD, process.env.CLAUDE_CONFIG_DIR);
	const s2 = createSession({
		sessionId: sid,
		projectPath: CWD,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		model: MODEL,
	});
	s2.addUserMessage("Please remember: the token is BETA.");
	s2.addAssistantMessage([{ type: "text", text: "Got it, the token is BETA." }]);
	s2.save();

	expect(s2.sessionId, "createSession should preserve sessionId when opts.sessionId is passed").toBe(sid);
	expect(existsSync(s2.jsonlPath), "save() should have recreated the file at the preserved path").toBeTruthy();

	const r2 = await askToken(sid);
	expect(r2, `expected BETA after delete+recreate, got: ${r2}`).toMatch(/beta/i);
	expect(r2, `stale ALPHA returned after delete+recreate: ${r2}`).not.toMatch(/alpha/i);
});

test("rebuild over CC-written tool_use records resolves cleanly", { timeout: 180_000 }, async () => {
	const sid = randomUUID();
	const s1 = seedTextSession(sid, "GAMMA");

	// Provoke a real tool call so CC writes tool_use/tool_result records to the
	// session file mid-execution. package.json is guaranteed to exist at CWD.
	await drain(query({
		prompt: "Use the Read tool to read package.json and tell me the top-level name field (one word).",
		options: { resume: sid, model: MODEL, cwd: CWD, permissionMode: "bypassPermissions" },
	}));

	const afterToolUse = countRecords(s1.jsonlPath);
	expect(afterToolUse.toolUse > 0, `CC did not write tool_use records — test is not exercising the target path. Records: ${JSON.stringify(afterToolUse)}`).toBeTruthy();

	// Rebuild with preserved sessionId via the same primitive syncSharedSession uses.
	deleteSession(sid, CWD, process.env.CLAUDE_CONFIG_DIR);
	const s2 = createSession({
		sessionId: sid,
		projectPath: CWD,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		model: MODEL,
	});
	s2.addUserMessage("Please remember: the token is DELTA. Forget any previous tokens.");
	s2.addAssistantMessage([{ type: "text", text: "Got it, the token is DELTA." }]);
	s2.save();

	const afterRebuild = countRecords(s2.jsonlPath);
	expect(afterRebuild.total, `rebuild should leave exactly 2 records, got ${afterRebuild.total}`).toBe(2);
	expect(afterRebuild.toolUse, `rebuild should wipe tool_use records, got ${afterRebuild.toolUse}`).toBe(0);
	expect(afterRebuild.toolResult, `rebuild should wipe tool_result records, got ${afterRebuild.toolResult}`).toBe(0);

	const r2 = await askToken(sid);
	expect(r2, `expected DELTA after rebuild over tool records, got: ${r2}`).toMatch(/delta/i);
	expect(r2, `stale GAMMA after rebuild: ${r2}`).not.toMatch(/gamma/i);
});

test("deleteSession wipes the companion directory", () => {
	const sid = randomUUID();
	const s1 = seedTextSession(sid, "EPSILON");
	const companionDir = s1.jsonlPath.replace(/\.jsonl$/, "");

	// Simulate CC's runtime behavior by seeding a file inside the companion dir.
	mkdirSync(join(companionDir, "tool-results"), { recursive: true });
	const sentinel = join(companionDir, "tool-results", "sentinel.txt");
	writeFileSync(sentinel, "stale artifact from a previous rebuild");
	expect(existsSync(sentinel), "pre-check: sentinel should exist").toBeTruthy();

	deleteSession(sid, CWD, process.env.CLAUDE_CONFIG_DIR);

	expect(existsSync(s1.jsonlPath), "jsonl should be deleted").toBeFalsy();
	expect(existsSync(sentinel), "sentinel inside companion dir should be deleted").toBeFalsy();
	expect(existsSync(companionDir), "companion dir should be deleted").toBeFalsy();
});
