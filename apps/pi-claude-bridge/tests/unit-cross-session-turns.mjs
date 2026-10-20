/**
 * Cross-session conversation isolation, at the level of real turn sequences.
 *
 * The bridge serves several pi sessions from one process (pi-subagents children
 * run their own AgentSessions through the same registered streamSimple). These
 * tests drive real turn sequences through the provider with a mocked SDK
 * query() (see setQuery) — no Claude Code subprocess runs — and pin the
 * invariant every smaller unit test cannot check on its own:
 *
 *   A session's CC conversation belongs to that session. A foreign session —
 *   foreground or background, erroring or succeeding — can never claim, resume,
 *   rewrite or delete it.
 *
 * The scenarios come from a reproduced failure of the pre-Map design: a
 * foreground child completing inside the parent's first turn permanently
 * reassigned the shared session slot to the child's conversation, and the
 * parent's own completion then deleted its file.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { getSessionPath } from "cc-session-io";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

// Before importing the module: the bridge resolves config and CC paths at import
// time, and the fake model below exercises claudeCodeModelId's pricing lookup —
// point both at throwaway dirs so no real state is read or written.
const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-cross-session-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const { __test } = await import("../src/index.js");
const { setQuery, getSharedSession, resetSharedSession } = __test;

// Build the provider entry the way pi hands it to the extension: call the
// module's default export with stub registration hooks, keep the real
// streamSimple that lands in the provider config.
const mod = await import("../src/index.js");
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
// A real registered model object, not a bare {id}: pi-ai's calculateCost reads
// the pricing tiers off it for every usage update.
const model = providerConfig.models[0];

// --- fake SDK query ---
// scripts is a queue; each turn pops one. init(id) seeds the captured session
// id; toolUse parks a mid-turn tool call whose delivery the caller controls.
const calls = [];
const scripts = [];
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; };
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const ev = (event) => ({ type: "stream_event", event });
const toolUse = (id) => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const result = (text) => ({ type: "result", subtype: "success", is_error: false, result: text });

// --- pi-side message builders (same shapes pi hands to streamSimple) ---
let clock = 0;
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const asst = (content, stopReason = "stop") => ({ role: "assistant", content, api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: clock++ });
const toolCall = (id) => asst([{ type: "toolCall", id, name: "read", arguments: { path: "a" } }], "toolUse");
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: clock++ });
const say = (text) => asst([{ type: "text", text }]);

const call = (sessionId, messages) => streamSimple(model, { messages, tools: [] }, { sessionId });
const settle = () => new Promise((r) => setTimeout(r, 20));
// A served tool: only then does a scripted tool_use end pi's stream at the tool
// boundary, leaving the query parked until pi delivers the result.
const tools = [{ name: "read", description: "Read a fixture file.", parameters: Type.Object({ path: Type.String() }) }];
const callWithTool = (sessionId, messages, signal) => streamSimple(model, { messages, tools }, { sessionId, signal });
const settled = async (sessionId) => {
	for (let i = 0; i < 400 && [...__test.activeQueryContexts].some((c) => c.piSessionId === sessionId); i++) await new Promise((r) => setTimeout(r, 5));
	assert.ok(![...__test.activeQueryContexts].some((c) => c.piSessionId === sessionId), `${sessionId} settled`);
};

beforeEach(() => {
	resetSharedSession();
	calls.length = 0;
	scripts.length = 0;
	setQuery(({ options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		calls.push({ label: script.label, resume: options.resume });
		// close() ends a query parked on a gate, as killing the CLI would.
		let closed = false, markClosed;
		const closing = new Promise((r) => { markClosed = r; });
		const gen = (async function* () {
			for (const step of script.steps) {
				if (typeof step === "function") { await Promise.race([step(), closing]); if (closed) return; continue; }
				yield options.resume && step.type === "system" ? { ...step, session_id: options.resume } : step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => { closed = true; markClosed(); };
		return gen;
	});
});

afterEach(() => {
	setQuery(null);
});

describe("cross-session conversation isolation", () => {
	it("a foreground child in the parent's first turn cannot claim the parent's conversation", async () => {
		const P = "pi-parent", C = "pi-child";
		const u1 = user("research X"), a1 = toolCall("toolu_P1"), tr1 = toolResult("toolu_P1"), a2 = say("parent answer"), u2 = user("now fix it");
		const gP = gate();

		// Parent's first turn parks on a tool call — held open until the child
		// below has run, so the child's completion lands inside the parent's turn.
		scripts.push({ label: "P turn 1", steps: [init("cc-P"), ...toolUse("toolu_P1"), gP.wait, result("parent answer")] });
		const p1 = call(P, [u1]);
		await settle();

		// A foreground child runs to completion while the parent is parked.
		scripts.push({ label: "child", steps: [init("cc-C"), result("child answer")] });
		await call(C, [user("child task")]).result();

		// The parked tool result resumes the parent turn and completes it —
		// delivery routes into the parked query's stdin (see deliverToolResults),
		// continuing the one query. The gate opening models that continuation.
		gP.open();
		await p1.result();

		scripts.push({ label: "P turn 2", steps: [init("cc-P2"), result("ok")] });
		await call(P, [u1, a1, tr1, a2, u2]).result();

		assert.equal(calls.at(-1).resume, "cc-P",
			"the parent's turn 2 resumes its own conversation, not the child's");
	});

	it("a background child finishing after the parent leaves the parent's conversation in place", async () => {
		const P = "pi-parent", C = "pi-child";
		const u1 = user("research X"), a2 = say("parent answer"), u2 = user("now fix it");
		const gC = gate();

		scripts.push({ label: "P turn 1", steps: [init("cc-P"), result("parent answer")] });
		await call(P, [u1]).result();
		assert.equal(getSharedSession(P).sessionId, "cc-P");

		// Background child starts and parks; the parent proceeds without it.
		scripts.push({ label: "child", steps: [init("cc-C"), gC.wait, result("child answer")] });
		const child = call(C, [user("child task")]);

		scripts.push({ label: "P turn 2", steps: [init("cc-P2"), result("ok")] });
		await call(P, [u1, a2, u2]).result();
		assert.equal(calls.at(-1).resume, "cc-P", "the parent keeps resuming its own conversation");

		gC.open();
		await child.result();

		assert.equal(getSharedSession(P).sessionId, "cc-P",
			"the child's completion cannot reassign the parent's conversation");
		const childSlot = getSharedSession(C);
		assert.ok(childSlot && childSlot.sessionId === "cc-C", "the child keeps its own conversation for its next turn");
		assert.equal(childSlot.piSessionId, C, "tagged with the session that owns it");
	});

	it("a missed steer survives successful completion and rebuilds the next turn", async () => {
		const P = "pi-parent";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("second"), missed = user("missed steer"), a2 = say("second answer"), u3 = user("third");
		const g = gate();

		scripts.push({ label: "first", steps: [init("cc-missed"), result("first answer")] });
		await call(P, [u1]).result();

		scripts.push({ label: "second", steps: [init("cc-P2"), g.wait, result("second answer")] });
		const second = call(P, [u1, a1, u2]);
		await settle();
		assert.equal(calls.at(-1).resume, "cc-missed");

		// The CLI has stopped accepting input, but still returns a successful
		// result. Model the provider's tool-result path counting the steer before
		// the next turn, so cursor-based sync alone cannot recover it.
		const context = [...__test.activeQueryContexts].find((c) => c.piSessionId === P);
		assert.ok(context, "second turn is still active");
		context.promptStream.fail(new Error("prompt stream closed"));
		await __test.deliverToolResults(context, [], [{ type: "text", text: "missed steer" }], 4);
		getSharedSession(P).cursor = 4;
		context.latestCursor = 4;
		assert.equal(getSharedSession(P).needsRebuild, true);
		g.open();
		await second.result();
		assert.equal(getSharedSession(P).needsRebuild, true, "completion must not forget the missed steer");

		const rebuiltFile = getSessionPath("cc-missed", process.cwd(), claudeDir);
		assert.equal(existsSync(rebuiltFile), false, "the fake SDK has not written a session file");
		scripts.push({ label: "third", steps: [init("cc-P3"), result("third answer")] });
		await call(P, [u1, a1, u2, missed, a2, u3]).result();
		assert.equal(existsSync(rebuiltFile), true, "the next turn imports pi history rather than reusing CC's incomplete session");
		assert.match(readFileSync(rebuiltFile, "utf8"), /missed steer/, "the rebuilt history includes the undelivered steer");
		assert.ok(!getSharedSession(P).needsRebuild, "the rebuilt turn clears the query's missed-steer mark");
	});

	it("a missed steer in the first turn rebuilds even without an existing mirror", async () => {
		const P = "pi-first-miss";
		const u1 = user("first"), missed = user("missed first-turn steer"), a1 = say("first answer"), u2 = user("second");
		const g = gate();

		scripts.push({ label: "first", steps: [init("cc-first-missed"), g.wait, result("first answer")] });
		const first = call(P, [u1]);
		await settle();
		assert.equal(getSharedSession(P), null, "clean start has no mirror until completion");

		const context = [...__test.activeQueryContexts].find((c) => c.piSessionId === P);
		assert.ok(context, "first turn is still active");
		context.promptStream.fail(new Error("prompt stream closed"));
		await __test.deliverToolResults(context, [], [{ type: "text", text: "missed first-turn steer" }], 2);
		context.latestCursor = 2;
		g.open();
		await first.result();
		assert.equal(getSharedSession(P).needsRebuild, true, "completion records the miss despite having no earlier mirror");

		const rebuiltFile = getSessionPath("cc-first-missed", process.cwd(), claudeDir);
		assert.equal(existsSync(rebuiltFile), false);
		scripts.push({ label: "second", steps: [init("cc-first-missed"), result("second answer")] });
		await call(P, [u1, missed, a1, u2]).result();
		assert.match(readFileSync(rebuiltFile, "utf8"), /missed first-turn steer/);
		assert.ok(!getSharedSession(P).needsRebuild, "the next query starts without the prior miss");
	});

	it("a parent error followed by a child turn does not hand the child the parent's conversation", async () => {
		const P = "pi-parent", C = "pi-child";
		const u1 = user("research X"), a2 = say("parent answer"), u2 = user("now fix it");

		scripts.push({ label: "P turn 1", steps: [init("cc-P"), result("parent answer")] });
		await call(P, [u1]).result();

		scripts.push({ label: "child during backoff", steps: [init("cc-C"), result("child answer")] });
		await call(C, [user("child task")]).result();

		scripts.push({ label: "P turn 2", steps: [init("cc-P2"), result("ok")] });
		await call(P, [u1, a2, u2]).result();

		assert.equal(calls.at(-1).resume, "cc-P",
			"the parent resumes its own conversation after a child ran while it backed off");
	});
});

describe("reentrancy is judged within the calling session", () => {
	/** P's first turn parks on a served tool call; finish() delivers the result. */
	async function parkP(P) {
		const g = gate();
		scripts.push({ label: "P parks", steps: [init("cc-P"), ...toolUse("toolu_P1"), g.wait, result("parent answer")] });
		const history = [user("parent task")];
		const parked = await callWithTool(P, history).result();
		assert.equal(parked.stopReason, "toolUse", "P sits at its tool call");
		return {
			async finish() {
				const finishing = callWithTool(P, [...history, parked, toolResult("toolu_P1")]).result();
				g.open();
				assert.equal((await finishing).stopReason, "stop");
				await settled(P);
				assert.equal(getSharedSession(P).sessionId, "cc-P", "P completes on its own conversation");
				assert.equal(getSharedSession(P).cursor, 3);
			},
		};
	}

	it("another session parked at a tool call does not turn a shortened history into a clean start", async () => {
		const P = "pi-parked", B = "pi-folded";
		const p = await parkP(P);

		const setup = user("setup"), first = user("first");
		scripts.push({ label: "B 1", steps: [init("cc-B"), result("b1")] });
		const a1 = await callWithTool(B, [setup, first]).result();
		await settled(B);
		scripts.push({ label: "B 2", steps: [init("cc-B2"), result("b2")] });
		await callWithTool(B, [setup, first, a1, user("second")]).result();
		await settled(B);
		assert.equal(getSharedSession(B).cursor, 4);

		// An extension folds B's history without any pi event: two priors replace four.
		scripts.push({ label: "B folded", steps: [init("cc-B3"), result("b3")] });
		await callWithTool(B, [user("summary of B so far"), say("noted"), user("after fold")]).result();
		await settled(B);
		assert.equal(calls.at(-1).resume, "cc-B", "B rebuilds its own conversation from the folded history and resumes it");
		assert.match(readFileSync(getSessionPath("cc-B", process.cwd(), claudeDir), "utf8"), /summary of B so far/);
		assert.equal(getSharedSession(B).sessionId, "cc-B");
		assert.equal(getSharedSession(B).cursor, 3);

		await p.finish();
	});

	it("an aborted session's orphaned tool result advances its own cursor while another session runs", async () => {
		const P = "pi-running", B = "pi-aborted";
		const p = await parkP(P);

		const first = user("first");
		scripts.push({ label: "B 1", steps: [init("cc-B"), result("b1")] });
		const a1 = await callWithTool(B, [first]).result();
		await settled(B);
		const abort = new AbortController();
		scripts.push({ label: "B aborted", steps: [init("cc-B2"), ...toolUse("toolu_B2"), gate().wait, result("unreachable")] });
		const history = [first, a1, user("second")];
		const parked = await callWithTool(B, history, abort.signal).result();
		assert.equal(parked.stopReason, "toolUse");
		abort.abort();
		await settled(B);

		const queued = calls.length;
		const orphan = await callWithTool(B, [...history, parked, toolResult("toolu_B2")], abort.signal).result();
		assert.equal(orphan.stopReason, "stop");
		assert.equal(orphan.content.length, 0);
		assert.equal(calls.length, queued, "no query starts for the orphaned result");
		assert.equal(getSharedSession(B).cursor, 5, "B's cursor counts the orphaned result");
		assert.equal(getSharedSession(B).sessionId, "cc-B");
		assert.equal(getSharedSession(P), null, "P's mirror is untouched until its own turn completes");

		await p.finish();
	});

	it("a user-only call while the same session's query is parked stays reentrant and preserves that session", async () => {
		const B = "pi-reentrant";
		const first = user("first");
		scripts.push({ label: "B 1", steps: [init("cc-B"), result("b1")] });
		const a1 = await callWithTool(B, [first]).result();
		await settled(B);
		const g = gate();
		scripts.push({ label: "B parks", steps: [init("cc-B2"), ...toolUse("toolu_B2"), g.wait, result("b2")] });
		const history = [first, a1, user("second")];
		const parked = await callWithTool(B, history).result();
		assert.equal(parked.stopReason, "toolUse");

		scripts.push({ label: "B reentrant", steps: [init("cc-B-side"), result("side answer")] });
		await callWithTool(B, [user("side question")]).result();
		assert.equal(calls.at(-1).resume, undefined, "the reentrant query starts clean");
		assert.equal(getSharedSession(B).sessionId, "cc-B", "and leaves the session's conversation in place");

		const finishing = callWithTool(B, [...history, parked, toolResult("toolu_B2")]).result();
		g.open();
		assert.equal((await finishing).stopReason, "stop");
		await settled(B);
		assert.equal(getSharedSession(B).sessionId, "cc-B");
		assert.equal(getSharedSession(B).cursor, 5);
	});
});
