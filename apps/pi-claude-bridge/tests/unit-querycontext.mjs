/**
 * Tests for the QueryContext class and the per-session query registry.
 * Exercises turn-state reset, session-keyed top-level state and its release
 * using the real modules — no API calls, no extension activation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createQueryRegistry, QueryContext } from "../src/provider/query-context.js";
import { createBridgeRuntime } from "../src/runtime.js";
import { registerBridge } from "../src/provider/registration.js";

const fakeModel = { api: "anthropic", provider: "anthropic", id: "test-model" };
const debug = () => {};

/** A top-level context with a query in flight, as startProviderQuery leaves it. */
function startQuery(registry, piSessionId) {
	const c = registry.sessionQueryContextFor(piSessionId);
	c.activeQuery = {};
	c.piSessionId = piSessionId;
	registry.activeQueryContexts.add(c);
	return c;
}

function parkHandler(c, id) {
	const replies = [];
	c.pendingToolCalls.set(id, { toolName: "read", resolve: (reply) => replies.push(reply) });
	return replies;
}

describe("QueryContext class", () => {
	it("turnBlocks throws before resetTurnState", () => {
		assert.throws(() => new QueryContext().turnBlocks, /turnBlocks accessed before resetTurnState/);
	});

	it("turnBlocks reflects turnOutput.content after resetTurnState", () => {
		const c = new QueryContext();
		c.resetTurnState(fakeModel);
		assert.ok(Array.isArray(c.turnBlocks));
		assert.strictEqual(c.turnBlocks.length, 0);

		c.turnBlocks.push({ type: "text", text: "hello" });
		assert.strictEqual(c.turnOutput.content.length, 1);
		assert.strictEqual(c.turnOutput.content[0].text, "hello");
		// Same array reference
		assert.strictEqual(c.turnBlocks, c.turnOutput.content);
	});

	it("resetTurnState preserves turnToolCallIds", () => {
		const c = new QueryContext();
		c.turnToolCallIds = ["id1", "id2"];
		c.resetTurnState(fakeModel);

		assert.deepStrictEqual(c.turnToolCallIds, ["id1", "id2"]);
	});
});

describe("per-session query state", () => {
	it("keeps one top-level context per pi session; calls without an id share (none)", () => {
		const registry = createQueryRegistry({ debug });
		const a = registry.sessionQueryContextFor("pi-a");
		assert.equal(registry.sessionQueryContextFor("pi-a"), a);
		assert.notEqual(registry.sessionQueryContextFor("pi-b"), a);
		assert.equal(registry.sessionQueryContextFor(null), registry.sessionQueryContextFor(undefined));
		assert.notEqual(registry.sessionQueryContextFor(null), a);
		assert.deepEqual([...registry.sessionQueryContexts.keys()], ["pi-a", "pi-b", "(none)"]);
		assert.notEqual(createQueryRegistry({ debug }).sessionQueryContextFor("pi-a"), a, "each runtime owns its own state");
	});

	it("judges reentrancy only from the calling session's top-level query", () => {
		const registry = createQueryRegistry({ debug });
		assert.equal(registry.isSessionQueryActive("pi-a"), false);
		assert.equal(registry.sessionQueryContexts.size, 0, "asking does not create state");
		startQuery(registry, "pi-a");
		assert.equal(registry.isSessionQueryActive("pi-a"), true);
		assert.equal(registry.isSessionQueryActive("pi-b"), false, "another session's live query does not make this one reentrant");
		assert.equal(registry.isSessionQueryActive(null), false);

		startQuery(registry, null);
		assert.equal(registry.isSessionQueryActive(undefined), true, "unattributed calls judge within the (none) bucket");

		// A reentrant query lives outside the session map: it is in flight for its
		// session, but the session's top-level slot stays free.
		const reentrant = new QueryContext();
		reentrant.piSessionId = "pi-b";
		registry.activeQueryContexts.add(reentrant);
		assert.equal(registry.isSessionQueryActive("pi-b"), false);
		assert.equal(registry.hasQueryInFlightForSession("pi-b"), true);
		assert.equal(registry.hasQueryInFlightForSession("pi-c"), false);
		assert.equal(registry.hasQueryInFlightForSession(null), true);
	});

	it("releases only the ending session and settles its idle leftovers, once", () => {
		const registry = createQueryRegistry({ debug });
		const live = startQuery(registry, "pi-live");
		const liveReplies = parkHandler(live, "toolu_live");
		const ending = registry.sessionQueryContextFor("pi-ending");
		const endingReplies = parkHandler(ending, "toolu_ending");

		registry.releaseSessionQueryContext("pi-ending");
		assert.equal(registry.sessionQueryContexts.has("pi-ending"), false);
		assert.deepEqual(endingReplies, [{ content: [{ type: "text", text: "Session ended." }] }]);
		assert.equal(ending.pendingToolCalls.size, 0);
		assert.equal(registry.sessionQueryContextFor("pi-live"), live, "another session keeps its state");
		assert.equal(live.activeQuery !== null && live.pendingToolCalls.size === 1 && liveReplies.length === 0, true,
			"another session's running query is not ended");

		registry.releaseSessionQueryContext("pi-ending");
		assert.equal(endingReplies.length, 1, "a repeated release finds nothing to settle");
		const next = registry.sessionQueryContextFor("pi-ending");
		assert.notEqual(next, ending, "the session's next query starts on fresh state");
		registry.activeQueryContexts.delete(ending);
		assert.equal(registry.sessionQueryContextFor("pi-ending"), next, "the released context's cleanup cannot remove the new one");
	});

	it("leaves a query still in flight to its own run", () => {
		const registry = createQueryRegistry({ debug });
		const running = startQuery(registry, "pi-running");
		const replies = parkHandler(running, "toolu_running");
		registry.releaseSessionQueryContext("pi-running");
		assert.equal(registry.sessionQueryContexts.has("pi-running"), false);
		assert.equal(registry.activeQueryContexts.has(running), true);
		assert.equal(replies.length, 0, "its handlers settle when its own completion runs");
	});

	it("a release reaches the module instance that serves the session", () => {
		const serving = createQueryRegistry({ debug });
		const notified = createQueryRegistry({ debug });
		serving.sessionQueryContextFor("pi-child");
		const parent = serving.sessionQueryContextFor("pi-parent");
		notified.sponsorReleaseSessionQueries("pi-child");
		assert.equal(serving.sessionQueryContexts.has("pi-child"), false);
		assert.equal(serving.sessionQueryContextFor("pi-parent"), parent);
	});

	it("session_shutdown releases the ending session through production registration", () => {
		const handlers = new Map();
		const pi = {
			registerProvider() {}, appendEntry() {},
			on(event, handler) { const all = handlers.get(event) ?? []; all.push(handler); handlers.set(event, all); },
		};
		// The instance whose handlers see the event is not the one serving the calls.
		const notified = createBridgeRuntime();
		const serving = createBridgeRuntime();
		registerBridge(pi, notified);
		const ending = serving.sessionQueryContextFor("pi-ending");
		const endingReplies = parkHandler(ending, "toolu_ending");
		const live = startQuery(serving, "pi-live");
		const shutdown = () => {
			for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown" }, { sessionManager: { getSessionId: () => "pi-ending" } });
		};
		try {
			shutdown();
			assert.equal(serving.sessionQueryContexts.has("pi-ending"), false);
			assert.equal(endingReplies.length, 1);
			assert.equal(serving.sessionQueryContextFor("pi-live"), live);
			assert.equal(live.activeQuery !== null && serving.activeQueryContexts.has(live), true);
			shutdown();
			assert.equal(endingReplies.length, 1, "a repeated shutdown is a no-op");
		} finally {
			serving.activeQueryContexts.delete(live);
		}
	});
});
