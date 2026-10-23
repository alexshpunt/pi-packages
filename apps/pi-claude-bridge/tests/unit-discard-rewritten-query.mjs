/**
 * Unit tests for the compaction loop at a tool boundary (issue #101).
 *
 * pi checks its compaction threshold at every turn boundary inside a run, so it
 * can rewrite the history while a Claude Code query sits parked waiting for a
 * tool result. Tool-result delivery is the one provider call that never reaches
 * syncSharedSession, so `needsRebuild` alone does not stop it: the result goes
 * into the parked query, CC answers over the pre-compaction conversation and
 * reports its full usage, and pi crosses the same threshold at the next
 * boundary. Measured in a since-removed mid-turn compaction integration test as
 * five compactions in one turn with the reported context going *up*, 76,333 → 77,289.
 *
 * These pin the three things that let the turn survive: the rewrite is recorded, attributed to
 * the pi session that rewrote (a subagent's own AgentSession compacts while the
 * parent sits parked on the Agent tool result — cross-session marks would kill
 * the parent's healthy query), the parked query stops being a routing target,
 * and it cannot reach back and overwrite what replaced it.
 *
 * Session mirrors are per pi session (a Map keyed by options.sessionId), so
 * markRebuildForSession arms and discards only the rewriting session's queries,
 * and its teardown marks touch only that session's mirror.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { QueryContext } from "../src/features/query/state.js";
import { QueryExecution } from "../src/features/query/lifecycle.js";

const scopes = [];
afterEach(async () => {
	for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
});

const { testBridge } = await import("../tools/verify/fixture-entry.js");
const {
	activeQueryContexts, armStaleContexts, contextForToolResults, discardRewrittenQuery,
	historyRewrittenBySession, isQueryAbandoned, markRebuildForSession,
	getSharedSession, resetSharedSession, setSharedSession,
} = testBridge;

/** A query parked mid-turn: CC asked for a tool and is waiting on the answer. */
function parkedQuery(toolCallId = "call_1", piSessionId = "pi-parent") {
	const events = [];
	const sdkQuery = {
		interrupt: () => { events.push("interrupt"); return Promise.resolve(); },
		close: () => { events.push("close"); },
	};
	const c = new QueryContext();
	c.activeQuery = sdkQuery;
	const scope = Scope.makeUnsafe("sequential");
	scopes.push(scope);
	c.execution = new QueryExecution(sdkQuery, scope);
	c.piSessionId = piSessionId;
	c.turnToolCallIds = [toolCallId];
	c.pendingToolCalls.set(toolCallId, {
		toolName: "read",
		resolve: (result) => { events.push(`release:${result.content[0].text.slice(0, 20)}`); },
	});
	c.promptStream = { fail: (error) => { events.push(`fail:${error.message}`); } };
	activeQueryContexts.add(c);
	return { c, sdkQuery, events };
}

const toolResults = [{ toolCallId: "call_1", content: [{ type: "text", text: "file contents" }] }];

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	historyRewrittenBySession.clear();
});

describe("markRebuildForSession", () => {
	it("records the rewrite before any Claude Code session exists", () => {
		// The mirror is assigned when a query *completes*, so a session can have
		// none for a whole first turn — and a first turn is long enough to compact.
		expect(getSharedSession("pi-parent"), "precondition: nothing has completed yet").toBe(null);

		markRebuildForSession("pi-parent", "session_compact:threshold");

		expect(historyRewrittenBySession.has("pi-parent"), "recorded only on the session, the first turn's parked query survives the compaction").toBeTruthy();
	});

	it("arms only the parked queries of the rewriting pi session", () => {
		const { c } = parkedQuery("call_1", "pi-parent");
		const sub = parkedQuery("call_sub", "pi-subagent");

		markRebuildForSession("pi-parent", "session_compact:threshold");
		armStaleContexts();

		expect(c.historyStale, "the parent's query really was built from the history pi just rewrote").toBe(true);
		expect(sub.c.historyStale, "the subagent parked inside the parent's tool call — its conversation was never rewritten").toBe(false);
	});

	it("arms nothing when the rewrite cannot be attributed", () => {
		const { c } = parkedQuery();

		markRebuildForSession(null, "session_compact:manual");
		armStaleContexts();

		expect(c.historyStale, "conservative: killing a live query on an unattributed rewrite needs proof").toBe(false);
	});

	it("forces the next sync down the rebuild path for the owning session's conversation", () => {
		// Session mirrors are per pi session: parent and subagent each have one.
		setSharedSession("pi-a", { sessionId: "abc", cursor: 3, cwd: "/tmp", needsRebuild: false, piSessionId: "pi-a" });
		setSharedSession("pi-b", { sessionId: "def", cursor: 2, cwd: "/tmp", needsRebuild: false, piSessionId: "pi-b" });

		markRebuildForSession("pi-b", "session_compact:threshold");
		expect(getSharedSession("pi-a").needsRebuild, "a subagent's compaction must not rebuild the conversation it never touched").toBe(false);
		expect(getSharedSession("pi-b").needsRebuild, "--resume would replay a history pi no longer has").toBe(true);

		markRebuildForSession(null, "session_compact:served");
		// An unattributed rewrite marks the "(none)" bucket — the only mirror a
		// direct caller without a session id can be serving.
		expect(getSharedSession("pi-a").needsRebuild, "the parent's mirror is untouched by an unattributed rewrite").toBe(false);
		// The discard set is keyed differently from the mirror on purpose: its
		// readers all guard on a real piSessionId, so a "(none)" entry here could
		// never be matched or consumed — only leaked.
		expect(historyRewrittenBySession.has("(none)"), "a null mark records no set entry: no reader could match or consume one").toBeFalsy();
	});

	it("arms the discarding session's replacement after a second rewrite (mid-turn double compaction)", () => {
		// The set key was consumed by the first discard; a second compaction in
		// the same turn re-adds it and must arm the replacement query too — the
		// replacement's reset (streamClaudeAgentSdk fresh-query setup) only clears
		// staleness carried over from the query it replaced, not new marks.
		const { c } = parkedQuery("call_1", "pi-parent");
		markRebuildForSession("pi-parent", "session_compact:threshold");
		armStaleContexts();
		discardRewrittenQuery(c);
		expect(c.historyStale, "the discard's own query is stale by construction").toBe(true);

		const replacement = parkedQuery("call_2", "pi-parent");
		markRebuildForSession("pi-parent", "session_compact:threshold");
		armStaleContexts();

		expect(replacement.c.historyStale, "a history rewritten under the replacement's predecessor makes this one stale too").toBe(true);
		discardRewrittenQuery(replacement.c);
		expect(historyRewrittenBySession.has("pi-parent"), "and consumes the mark again").toBe(false);
		void c;
	});
});

describe("discardRewrittenQuery", () => {
	it.each(["missing", "closing", "closed", "mismatched"])("does not route a result to a %s resource owner", (state) => {
		const { c } = parkedQuery();
		if (state === "missing") c.execution = null;
		else if (state === "closing") c.execution.beginClosing();
		else if (state === "closed") c.execution.closed("completed");
		else c.activeQuery = {};
		expect(contextForToolResults(toolResults)).toBeUndefined();
	});

	it("stops the parked query being a routing target for the turn's result", () => {
		const { c } = parkedQuery();
		expect(contextForToolResults(toolResults), "precondition: the result routes to the parked query").toBe(c);

		discardRewrittenQuery(c);

		expect(contextForToolResults(toolResults), "a result routed here would answer over the conversation pi just discarded").toBe(undefined);
		expect(c.activeQuery).toBe(null);
		expect(activeQueryContexts.has(c), "routing matches ids only against contexts in this set").toBe(false);
	});

	it("settles everything awaiting the subprocess before killing it", () => {
		const { c, events } = parkedQuery();

		discardRewrittenQuery(c);

		const released = events.findIndex((e) => e.startsWith("release:"));
		const killed = events.indexOf("interrupt");
		expect(released !== -1, "a handler left awaiting a dead subprocess wedges pi's turn behind it").toBeTruthy();
		expect(killed !== -1 && released < killed, "handlers have to be released before the CLI goes").toBeTruthy();
		expect(events.includes("close"), "interrupt alone lets the current API call finish").toBeTruthy();
		expect(events.some((e) => e.startsWith("fail:")), "the parked ack has nothing left to resume it").toBeTruthy();
		expect(c.promptStream).toBe(null);
		expect(c.pendingToolCalls.size).toBe(0);
	});

	it("marks the query abandoned so its completion cannot overwrite the rebuild", () => {
		const { c, sdkQuery } = parkedQuery();
		expect(isQueryAbandoned(sdkQuery)).toBe(false);

		discardRewrittenQuery(c);

		expect(isQueryAbandoned(sdkQuery), "its completion handler would otherwise capture the stale session id over the rebuilt one").toBe(true);
	});

	it("consumes the mark for its pi session, leaving sibling sessions armed", () => {
		const { c } = parkedQuery("call_1", "pi-b");
		const other = parkedQuery("call_2", "pi-c");
		markRebuildForSession("pi-c", "session_compact:threshold");
		markRebuildForSession("pi-b", "session_compact:threshold");
		armStaleContexts();
		expect(historyRewrittenBySession.has("pi-b"), "precondition: armed").toBeTruthy();

		discardRewrittenQuery(c);

		expect(historyRewrittenBySession.has("pi-b"), "served").toBe(false);
		expect(historyRewrittenBySession.has("pi-c"), "a sibling pi session's rewrite is not ours to consume").toBeTruthy();
		void other;
	});

	it("rotates the session id of the discarding session's own mirror, because the rebuild follows the kill immediately", () => {
		setSharedSession("pi-parent", { sessionId: "abc", cursor: 3, cwd: "/tmp", piSessionId: "pi-parent" });
		const { c } = parkedQuery("call_1", "pi-parent");

		discardRewrittenQuery(c);

		// The CLI we just killed may still flush a record into the JSONL, and the
		// rebuild is the very next thing that happens — the abort path's reasoning,
		// with the race made tighter. Another session's mirror is never touched.
		const s = getSharedSession("pi-parent");
		expect(s.forceRotate).toBe(true);
		expect(s.needsRebuild).toBe(true);
	});

	it("leaves a foreign session's mirror untouched when the foreign query discards", () => {
		// pi-b's query parks, pi-b compacts, the discard rotates only pi-b's
		// mirror — when there is none. The parent's mirror is not pi-b's to rotate.
		setSharedSession("pi-parent", { sessionId: "parent", cursor: 3, cwd: "/tmp", needsRebuild: false, piSessionId: "pi-parent" });
		const { c } = parkedQuery("call_1", "pi-b");
		markRebuildForSession("pi-b", "session_compact:threshold");
		armStaleContexts();

		discardRewrittenQuery(c);

		const s = getSharedSession("pi-parent");
		expect(s.needsRebuild, "the child's rebuild must not force the parent's next sync").toBe(false);
		expect(s.forceRotate, "nor rotate it: the parent conversation is intact").toBe(undefined);
		expect(getSharedSession("pi-b"), "the child never had a mirror to rotate").toBe(null);
	});

	it("is safe on a context whose query already ended", () => {
		const c = new QueryContext();
		activeQueryContexts.add(c);

		discardRewrittenQuery(c);

		expect(c.activeQuery).toBe(null);
		expect(activeQueryContexts.has(c)).toBe(false);
	});
});

describe("per-session mirrors", () => {
	it("separates the CC conversations of two pi sessions", () => {
		setSharedSession("pi-a", { sessionId: "cc-a", cursor: 4, cwd: "/tmp", piSessionId: "pi-a" });
		setSharedSession("pi-b", { sessionId: "cc-b", cursor: 1, cwd: "/tmp", piSessionId: "pi-b" });

		expect(getSharedSession("pi-a").sessionId).toBe("cc-a");
		expect(getSharedSession("pi-b").sessionId).toBe("cc-b");
		expect(getSharedSession("pi-c"), "a session with no mirror has none").toBe(null);

		resetSharedSession("pi-b");
		expect(getSharedSession("pi-b"), "reset clears only the keyed mirror").toBe(null);
		expect(getSharedSession("pi-a").sessionId, "a sibling survives the reset").toBe("cc-a");
	});

	it("shares one bucket for unattributed callers", () => {
		setSharedSession(null, { sessionId: "cc-none", cursor: 2, cwd: "/tmp", piSessionId: undefined });

		expect(getSharedSession(null).sessionId).toBe("cc-none");
		expect(getSharedSession("pi-a"), "an attributed session never touches the unattributed bucket").toBe(null);
	});
});
