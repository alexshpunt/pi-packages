#!/usr/bin/env node
// Integration test: an `@file` expansion survives a session rebuild.
//
// Claude Code expands an at-mention itself and stores the file's contents as a
// `type: "attachment"` record in its own session file. pi never sees it, so a
// rebuild from pi's history used to drop the file while keeping the prompt text
// that referred to it — the model silently lost something it was reasoning about.
//
// This drives the real thing rather than the plumbing: it asks Claude Code, over
// a resumed session, for a token that exists *only* inside the carried
// attachment. If the attachment did not reach the rebuilt session, CC cannot
// answer, because the token appears nowhere else in the conversation.
//
// The control matters as much as the assertion. The same rebuild without
// carrying the attachment must fail to produce the token — otherwise the test
// would pass for the wrong reason (CC reading the file off disk, guessing from
// the prompt, or the token leaking through some other path).
//
// Requires: Claude Code subscription login.

import { afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, openSession, deleteSession } from "cc-session-io";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { collectCarriedAttachments, placeCarriedAttachments } from "../src/attachments.js";

const CWD = mkdtempSync(join(tmpdir(), "cc-attachment-project-"));
afterAll(() => rmSync(CWD, { recursive: true, force: true }));
const MODEL = "claude-haiku-5-5";
// Nothing can infer this from the filename, the prompt, or the file on disk —
// it exists only in the attachment payload the rebuild has to carry.
const TOKEN = randomUUID();

const PROMPT = "Review @fixture.txt and remember it.";
const ASK = `What is the build token recorded in the file I attached? Reply with just the token.`;

function attachmentFor(dir) {
	const filePath = join(dir, "fixture.txt");
	const content = `# fixture\nbuild-token: ${TOKEN}\n`;
	// Never put the token on disk outside the session: only the attachment may supply it.
	return {
		type: "file",
		filename: filePath,
		content: { type: "text", file: { filePath, content } },
	};
}

/** The session as CC left it: prompt, attachment, reply. */
function seedWithAttachment(sid, attachment) {
	const session = createSession({
		sessionId: sid, projectPath: CWD,
		claudeDir: process.env.CLAUDE_CONFIG_DIR, model: MODEL,
	});
	session.importMessages(
		[
			{ role: "user", content: PROMPT },
			{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
		],
		{ attachments: [{ afterIndex: 0, attachment }] },
	);
	session.save();
	return session;
}

/** What syncSharedSession does on REBUILD, with and without the carry. */
function rebuild(sid, carried) {
	deleteSession(sid, CWD, process.env.CLAUDE_CONFIG_DIR);
	const session = createSession({
		sessionId: sid, projectPath: CWD,
		claudeDir: process.env.CLAUDE_CONFIG_DIR, model: MODEL,
	});
	const messages = [
		{ role: "user", content: PROMPT },
		{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
	];
	const placed = placeCarriedAttachments(carried, messages);
	session.importMessages(messages, placed.attachments.length ? { attachments: placed.attachments } : undefined);
	session.save();
	return { session, placed };
}

async function ask(sid) {
	let out = "";
	for await (const m of query({
		prompt: ASK,
		options: {
			resume: sid, model: MODEL, cwd: CWD,
			tools: [], strictMcpConfig: true, settingSources: [],
			settings: { disableAllHooks: true, autoMemoryEnabled: false },
			env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0" },
		},
	})) {
		if (m.type === "system" && m.subtype === "init") {
			expect(m.apiKeySource, "attachment checks require subscription authentication").toBe("none");
			expect(m.tools, "attachment checks must not expose tools").toEqual([]);
		}
		if (m.type === "assistant") {
			for (const block of m.message?.content ?? []) {
				expect(block.type, "the model must answer from the resumed transcript alone").not.toBe("tool_use");
				if (block.type === "text") out += block.text;
			}
		}
	}
	return out.trim();
}

test("an @file attachment survives a rebuild and reaches Claude", { timeout: 180_000 }, async () => {
	// The attachment points outside the repo to a nonexistent file. Native tools,
	// hooks and memory are disabled, so only the carried payload can reveal the token.
	const dir = mkdtempSync(join(tmpdir(), "cc-attachment-"));
	const sid = randomUUID();
	try {
		const attachment = attachmentFor(dir);
		const seeded = seedWithAttachment(sid, attachment);
		expect(seeded.attachments.length, "seed did not write the attachment").toBe(1);

		const carried = collectCarriedAttachments(
			openSession({ sessionId: sid, projectPath: CWD, claudeDir: process.env.CLAUDE_CONFIG_DIR }).records,
		);
		expect(carried.length, "collectCarriedAttachments did not find the attachment").toBe(1);

		const { session, placed } = rebuild(sid, carried);
		expect(placed.skipped.length, `placement skipped: ${placed.skipped.join("; ")}`).toBe(0);
		expect(session.attachments.length, "rebuilt session has no attachment").toBe(1);

		const answer = await ask(sid);
		expect(answer, `Claude could not see the carried attachment. Answer: ${answer}`).toMatch(new RegExp(TOKEN, "i"));
	} finally {
		deleteSession(sid, CWD, process.env.CLAUDE_CONFIG_DIR);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("control: without the carry, the same rebuild loses it", { timeout: 180_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "cc-attachment-"));
	const sid = randomUUID();
	try {
		seedWithAttachment(sid, attachmentFor(dir));
		const { session } = rebuild(sid, []);
		expect(session.attachments.length, "control rebuild should carry nothing").toBe(0);

		const answer = await ask(sid);
		expect(answer, `Control produced the token without the attachment — the positive test proves nothing. Answer: ${answer}`).not.toMatch(new RegExp(TOKEN, "i"));
	} finally {
		deleteSession(sid, CWD, process.env.CLAUDE_CONFIG_DIR);
		rmSync(dir, { recursive: true, force: true });
	}
});
