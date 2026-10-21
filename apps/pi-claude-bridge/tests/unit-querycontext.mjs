/**
 * Tests for the QueryContext class and the per-session query registry.
 * Exercises turn-state reset, session-keyed top-level state and its release
 * using the real modules — no API calls, no extension activation.
 */
import { describe, expect, it } from "vitest";
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
		expect(() => new QueryContext().turnBlocks).toThrow(/turnBlocks accessed before resetTurnState/);
	});

	it("turnBlocks reflects turnOutput.content after resetTurnState", () => {
		const c = new QueryContext();
		c.resetTurnState(fakeModel);
		expect(Array.isArray(c.turnBlocks)).toBeTruthy();
		expect(c.turnBlocks.length).toBe(0);

		c.turnBlocks.push({ type: "text", text: "hello" });
		expect(c.turnOutput.content.length).toBe(1);
		expect(c.turnOutput.content[0].text).toBe("hello");
		// Same array reference
		expect(c.turnBlocks).toBe(c.turnOutput.content);
	});

	it("resetTurnState preserves turnToolCallIds", () => {
		const c = new QueryContext();
		c.turnToolCallIds = ["id1", "id2"];
		c.resetTurnState(fakeModel);

		expect(c.turnToolCallIds).toStrictEqual(["id1", "id2"]);
	});
});

describe("per-session query state", () => {
	it("keeps one top-level context per pi session; calls without an id share (none)", () => {
		const registry = createQueryRegistry({ debug });
		const a = registry.sessionQueryContextFor("pi-a");
		expect(registry.sessionQueryContextFor("pi-a")).toBe(a);
		expect(registry.sessionQueryContextFor("pi-b")).not.toBe(a);
		expect(registry.sessionQueryContextFor(null)).toBe(registry.sessionQueryContextFor(undefined));
		expect(registry.sessionQueryContextFor(null)).not.toBe(a);
		expect([...registry.sessionQueryContexts.keys()]).toStrictEqual(["pi-a", "pi-b", "(none)"]);
		expect(createQueryRegistry({ debug }).sessionQueryContextFor("pi-a"), "each runtime owns its own state").not.toBe(a);
	});

	it("judges reentrancy only from the calling session's top-level query", () => {
		const registry = createQueryRegistry({ debug });
		expect(registry.isSessionQueryActive("pi-a")).toBe(false);
		expect(registry.sessionQueryContexts.size, "asking does not create state").toBe(0);
		startQuery(registry, "pi-a");
		expect(registry.isSessionQueryActive("pi-a")).toBe(true);
		expect(registry.isSessionQueryActive("pi-b"), "another session's live query does not make this one reentrant").toBe(false);
		expect(registry.isSessionQueryActive(null)).toBe(false);

		startQuery(registry, null);
		expect(registry.isSessionQueryActive(undefined), "unattributed calls judge within the (none) bucket").toBe(true);

		// A reentrant query lives outside the session map: it is in flight for its
		// session, but the session's top-level slot stays free.
		const reentrant = new QueryContext();
		reentrant.piSessionId = "pi-b";
		registry.activeQueryContexts.add(reentrant);
		expect(registry.isSessionQueryActive("pi-b")).toBe(false);
		expect(registry.hasQueryInFlightForSession("pi-b")).toBe(true);
		expect(registry.hasQueryInFlightForSession("pi-c")).toBe(false);
		expect(registry.hasQueryInFlightForSession(null)).toBe(true);
	});

	it("releases only the ending session and settles its idle leftovers, once", () => {
		const registry = createQueryRegistry({ debug });
		const live = startQuery(registry, "pi-live");
		const liveReplies = parkHandler(live, "toolu_live");
		const ending = registry.sessionQueryContextFor("pi-ending");
		const endingReplies = parkHandler(ending, "toolu_ending");

		registry.releaseSessionQueryContext("pi-ending");
		expect(registry.sessionQueryContexts.has("pi-ending")).toBe(false);
		expect(endingReplies).toStrictEqual([{ content: [{ type: "text", text: "Session ended." }] }]);
		expect(ending.pendingToolCalls.size).toBe(0);
		expect(registry.sessionQueryContextFor("pi-live"), "another session keeps its state").toBe(live);
		expect(live.activeQuery !== null && live.pendingToolCalls.size === 1 && liveReplies.length === 0, "another session's running query is not ended").toBe(true);

		registry.releaseSessionQueryContext("pi-ending");
		expect(endingReplies.length, "a repeated release finds nothing to settle").toBe(1);
		const next = registry.sessionQueryContextFor("pi-ending");
		expect(next, "the session's next query starts on fresh state").not.toBe(ending);
		registry.activeQueryContexts.delete(ending);
		expect(registry.sessionQueryContextFor("pi-ending"), "the released context's cleanup cannot remove the new one").toBe(next);
	});

	it("leaves a query still in flight to its own run", () => {
		const registry = createQueryRegistry({ debug });
		const running = startQuery(registry, "pi-running");
		const replies = parkHandler(running, "toolu_running");
		registry.releaseSessionQueryContext("pi-running");
		expect(registry.sessionQueryContexts.has("pi-running")).toBe(false);
		expect(registry.activeQueryContexts.has(running)).toBe(true);
		expect(replies.length, "its handlers settle when its own completion runs").toBe(0);
	});

	it("a release reaches the module instance that serves the session", () => {
		const serving = createQueryRegistry({ debug });
		const notified = createQueryRegistry({ debug });
		serving.sessionQueryContextFor("pi-child");
		const parent = serving.sessionQueryContextFor("pi-parent");
		notified.sponsorReleaseSessionQueries("pi-child");
		expect(serving.sessionQueryContexts.has("pi-child")).toBe(false);
		expect(serving.sessionQueryContextFor("pi-parent")).toBe(parent);
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
			expect(serving.sessionQueryContexts.has("pi-ending")).toBe(false);
			expect(endingReplies.length).toBe(1);
			expect(serving.sessionQueryContextFor("pi-live")).toBe(live);
			expect(live.activeQuery !== null && serving.activeQueryContexts.has(live)).toBe(true);
			shutdown();
			expect(endingReplies.length, "a repeated shutdown is a no-op").toBe(1);
		} finally {
			serving.activeQueryContexts.delete(live);
		}
	});
});
