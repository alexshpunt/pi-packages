import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSession, openSession } from "cc-session-io";
import { bindSessionLinks, lookupSessionLink, recordSessionLink, SESSION_LINK_TYPE } from "../src/session/continuity.js";
import { createMirrorStore } from "../src/session/mirror-store.js";
import { createBridgeRuntime } from "../src/runtime.js";
import { registerBridge } from "../src/provider/registration.js";
import { createHarness, fixtureUser } from "../tools/verify/harness.js";
import { withWorkspace } from "../tools/verify/workspace.js";

const links = manager => manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === SESSION_LINK_TYPE);
const state = (id, cwd, cursor = 1) => ({ sessionId: id, cwd, cursor });

async function withSessions(run) {
	return withWorkspace(false, async workspace => {
		const manager = SessionManager.inMemory(workspace.cwd);
		manager.appendMessage(fixtureUser("root"));
		const logs = [], releases = [], writes = new Map();
		const debug = (...values) => logs.push(values.join(" "));
		const bind = (target = manager) => {
			const pi = { appendEntry(type, data) {
				const entries = writes.get(target.getSessionId()) ?? [];
				entries.push(data); writes.set(target.getSessionId(), entries);
				target.appendCustomEntry(type, data);
			} };
			const release = bindSessionLinks(pi, { cwd: workspace.cwd, sessionManager: target }, debug);
			releases.push(release);
			return release;
		};
		bind();
		const mirror = createMirrorStore({ activeQueryContexts: new Set(), debug });
		try { return await run({ workspace, manager, bind, writes, logs, debug, mirror }); }
		finally { for (const release of releases.reverse()) release(); }
	});
}

it("records only changed CC ids and keeps minimal custom data out of model context", () => withSessions(({ workspace, manager, mirror }) => {
	const piId = manager.getSessionId(), first = randomUUID(), second = randomUUID();
	mirror.setSessionStateFor(piId, state(first, workspace.cwd));
	mirror.setSessionStateFor(piId, state(first, workspace.cwd, 10));
	mirror.setSessionStateFor(piId, null);
	expect(links(manager).length).toBe(1);
	expect(links(manager)[0].data).toStrictEqual({ schemaVersion: 1, ccSessionId: first, cwd: realpathSync(workspace.cwd) });
	mirror.setSessionStateFor(piId, state(second, workspace.cwd));
	expect(links(manager).length).toBe(2);
	const modelContext = JSON.stringify(manager.buildSessionContext().messages);
	expect(modelContext.includes(SESSION_LINK_TYPE)).toBe(false);
	expect(modelContext.includes(first)).toBe(false);
	expect(modelContext.includes(second)).toBe(false);
}));

it("restores the last connection on the active branch, not an abandoned newer branch", () => withSessions(({ workspace, manager, mirror, bind, debug }) => {
	const sessions = [0, 1].map(() => {
		const session = createSession({ projectPath: workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
		session.importMessages([{ role: "user", content: "seed" }]); session.save(); return session;
	});
	mirror.setSessionStateFor(manager.getSessionId(), state(sessions[0].sessionId, workspace.cwd));
	const firstLeaf = manager.getLeafId();
	manager.appendMessage(fixtureUser("alternative branch"));
	mirror.setSessionStateFor(manager.getSessionId(), state(sessions[1].sessionId, workspace.cwd));
	const secondLeaf = manager.getLeafId();
	manager.branch(firstLeaf); bind();
	expect(lookupSessionLink(manager.getSessionId(), workspace.cwd, debug)).toBe(sessions[0].sessionId);
	expect(manager.getEntries().filter(entry => entry.customType === SESSION_LINK_TYPE).length).toBe(2);
	manager.branch(secondLeaf); bind();
	expect(lookupSessionLink(manager.getSessionId(), workspace.cwd, debug)).toBe(sessions[1].sessionId);
}));

it("ignores unsupported, corrupt, foreign-cwd and missing latest links without reviving an older one", () => withSessions(({ workspace, manager, mirror, debug }) => {
	const source = createSession({ projectPath: workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
	source.importMessages([{ role: "user", content: "seed" }]); source.save();
	mirror.setSessionStateFor(manager.getSessionId(), state(source.sessionId, workspace.cwd));
	const validLeaf = manager.getLeafId();
	for (const data of [null, { schemaVersion: 2, ccSessionId: source.sessionId, cwd: workspace.cwd },
		{ schemaVersion: 1, ccSessionId: "../../outside", cwd: workspace.cwd },
		{ schemaVersion: 1, ccSessionId: source.sessionId, cwd: join(workspace.cwd, "different") },
		{ schemaVersion: 1, ccSessionId: randomUUID(), cwd: workspace.cwd }]) {
		manager.branch(validLeaf); manager.appendCustomEntry(SESSION_LINK_TYPE, data);
		expect(lookupSessionLink(manager.getSessionId(), workspace.cwd, debug)).toBe(undefined);
	}
	manager.branch(validLeaf);
	const backup = join(workspace.root, "source-backup.jsonl");
	writeFileSync(backup, readFileSync(source.jsonlPath));
	// A session-file symlink must not be followed even if its target is readable.
	rmSync(source.jsonlPath); symlinkSync(backup, source.jsonlPath);
	expect(lookupSessionLink(manager.getSessionId(), workspace.cwd, debug)).toBe(undefined);
}));


it("a shared provider mirror uses each child's appendEntry handle, not its parent's", () => withSessions(({ workspace, manager, mirror, bind, writes, logs }) => {
	const child = SessionManager.inMemory(workspace.cwd); child.appendMessage(fixtureUser("child")); bind(child);
	const parentCC = randomUUID(), childCC = randomUUID();
	mirror.setSessionStateFor(manager.getSessionId(), state(parentCC, workspace.cwd));
	mirror.setSessionStateFor(child.getSessionId(), state(childCC, workspace.cwd));
	expect(writes.get(manager.getSessionId()).length).toBe(1);
	expect(writes.get(child.getSessionId()).length).toBe(1);
	expect(links(manager)[0].data.ccSessionId).toBe(parentCC);
	expect(links(child)[0].data.ccSessionId).toBe(childCC);
	expect(logs.some(line => line.includes(`writer=${child.getSessionId()}`) && line.includes(childCC))).toBeTruthy();
	mirror.setSessionStateFor(null, state(randomUUID(), workspace.cwd));
	mirror.setSessionStateFor("unregistered", state(randomUUID(), workspace.cwd));
	expect(writes.get(manager.getSessionId()).length).toBe(1);
}));

it("stale release callbacks cannot unregister a new writer and shutdown removes the current writer", () => withSessions(({ workspace, manager, bind, mirror, writes }) => {
	const oldRelease = bind(), newRelease = bind();
	oldRelease();
	mirror.setSessionStateFor(manager.getSessionId(), state(randomUUID(), workspace.cwd));
	expect(writes.get(manager.getSessionId()).length).toBe(1);
	newRelease();
	mirror.setSessionStateFor(manager.getSessionId(), state(randomUUID(), workspace.cwd));
	expect(writes.get(manager.getSessionId()).length).toBe(1);
}));

it("does not write through a context whose session changed, and isolates storage failures", () => withSessions(({ workspace, manager, debug, mirror }) => {
	let currentId = manager.getSessionId(), calls = 0;
	const release = bindSessionLinks({ appendEntry() { calls++; throw new Error("controlled append failure"); } }, {
		cwd: workspace.cwd, sessionManager: { getSessionId: () => currentId, getBranch: () => manager.getBranch() },
	}, debug);
	try {
		const original = currentId;
		mirror.setSessionStateFor(original, state(randomUUID(), workspace.cwd));
		expect(calls).toBe(1);
		expect(mirror.sessionStateFor(original)).toBeTruthy();
		currentId = randomUUID();
		mirror.setSessionStateFor(original, state(randomUUID(), workspace.cwd));
		expect(calls).toBe(1);
		expect(lookupSessionLink(original, workspace.cwd, debug)).toBe(undefined);
	} finally { release(); }
}));

it("rebuilds with a new UUID from a persisted link without modifying the source session", () => withSessions(async ({ workspace, manager, debug }) => {
	const prompt = "Read the original fixture @file.txt";
	const source = createSession({ projectPath: workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
	source.importMessages([{ role: "user", content: prompt }, { role: "assistant", content: [{ type: "text", text: "done" }] }], {
		attachments: [{ afterIndex: 0, attachment: { type: "file", filename: "file.txt", content: { type: "text", file: { filePath: "file.txt", content: "original snapshot" } } } }],
	}); source.save();
	recordSessionLink(manager.getSessionId(), source.sessionId, workspace.cwd, debug);
	const oldBytes = readFileSync(source.jsonlPath);
	const harness = createHarness(workspace);
	try {
		expect(harness.runtime.sessionStateFor(manager.getSessionId())).toBe(null);
		const result = harness.runtime.syncSharedSession([fixtureUser(prompt),
			{ role: "assistant", provider: "claude-bridge", model: harness.model.id, content: [{ type: "text", text: "done" }], timestamp: 1 }, fixtureUser("continue")],
			workspace.cwd, undefined, harness.model.id, manager.getSessionId());
		expect(result.sessionId).not.toBe(source.sessionId);
		expect(readFileSync(source.jsonlPath)).toStrictEqual(oldBytes);
		const rebuilt = openSession({ sessionId: result.sessionId, projectPath: workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
		expect(rebuilt.attachments.length).toBe(1);
		expect(rebuilt.attachments[0].attachment.content.file.content).toBe("original snapshot");
		expect(links(manager).at(-1).data.ccSessionId).toBe(result.sessionId);
	} finally { await harness.close(); }
}));

it("falls back to a fresh rebuild when the branch link points to a missing file", () => withSessions(async ({ workspace, manager }) => {
	const missing = randomUUID();
	manager.appendCustomEntry(SESSION_LINK_TYPE, { schemaVersion: 1, ccSessionId: missing, cwd: realpathSync(workspace.cwd) });
	const harness = createHarness(workspace);
	try {
		const synced = harness.runtime.syncSharedSession([fixtureUser("previous"),
			{ role: "assistant", provider: "claude-bridge", model: harness.model.id, content: [{ type: "text", text: "answer" }], timestamp: 1 }, fixtureUser("next")],
			workspace.cwd, undefined, harness.model.id, manager.getSessionId());
		expect(synced.sessionId).not.toBe(missing);
		const session = openSession({ sessionId: synced.sessionId, projectPath: workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
		expect(session.messages.length).toBe(2);
		expect(session.attachments.length).toBe(0);
		expect(links(manager).at(-1).data.ccSessionId).toBe(synced.sessionId);
	} finally { await harness.close(); }
}));

it("binds on session_start/tree and releases on session_shutdown through production registration", () => withSessions(({ workspace, manager }) => {
	const handlers = new Map();
	const runtime = createBridgeRuntime();
	const pi = { registerProvider() {}, on(event, handler) { const all = handlers.get(event) ?? []; all.push(handler); handlers.set(event, all); },
		appendEntry(type, data) { manager.appendCustomEntry(type, data); } };
	const context = { cwd: workspace.cwd, mode: "rpc", sessionManager: manager, modelRegistry: { getProvider: () => ({}) }, ui: undefined };
	registerBridge(pi, runtime);
	const emit = (type, event = {}) => { for (const handler of handlers.get(type) ?? []) handler(event, context); };
	const root = manager.getLeafId(), ccId = randomUUID();
	emit("session_start", { reason: "resume" });
	runtime.setSessionStateFor(manager.getSessionId(), state(ccId, workspace.cwd));
	expect(links(manager).length).toBe(1);
	manager.branch(root); emit("session_tree");
	runtime.setSessionStateFor(manager.getSessionId(), state(ccId, workspace.cwd));
	expect(links(manager).length).toBe(1);
	expect(manager.getEntries().filter(entry => entry.customType === SESSION_LINK_TYPE).length).toBe(2);
	emit("session_shutdown");
	runtime.setSessionStateFor(manager.getSessionId(), state(randomUUID(), workspace.cwd));
	expect(links(manager).length).toBe(1);
}));
