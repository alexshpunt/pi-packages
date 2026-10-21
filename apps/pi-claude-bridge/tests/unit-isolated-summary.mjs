import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeRuntime } from "../src/runtime.js";

let runtime, model;
const context = { messages: [{ role: "user", content: "Summarize the fixture", timestamp: 0 }] };
const success = (usage) => ({ type: "result", subtype: "success", is_error: false, result: "Summary", usage });
const query = (messages, close = vi.fn()) => Object.assign((async function* () {
	for (const message of messages) yield message;
})(), { interrupt: vi.fn(async () => {}), close });
const summary = (options = {}) => runtime.isolatedStreamFn(model, context, { cacheRetention: "none", ...options });

beforeEach(() => {
	runtime = createBridgeRuntime();
	model = { ...runtime.MODELS[0], api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge" };
	runtime.setQuery(() => { throw new Error("No fake query installed"); });
});
afterEach(() => {
	runtime.withdrawRebuildHook();
	runtime.withdrawReleaseHook();
	vi.restoreAllMocks();
});

describe("isolated summary usage", () => {
	it("maps result input, output, cache and reasoning counters without double counting", async () => {
		runtime.setQuery(() => query([success({
			input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3,
			output_tokens_details: { thinking_tokens: 4 },
		})]));
		const result = await summary().result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toStrictEqual([{ type: "text", text: "Summary" }]);
		expect(result.usage).toStrictEqual({
			input: 10, output: 7, cacheRead: 5, cacheWrite: 3, reasoning: 4, totalTokens: 25,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});

	it("keeps assistant usage fields omitted by the final result", async () => {
		runtime.setQuery(() => query([
			{ type: "assistant", message: { content: [{ type: "text", text: "Assistant summary" }], usage: {
				input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5,
			} } },
			success({ output_tokens: 3 }),
		]));
		const result = await summary().result();
		expect(result.usage).toMatchObject({ input: 10, output: 3, cacheRead: 5, totalTokens: 18 });
	});

	it("keeps assistant-only text and usage when no result arrives", async () => {
		runtime.setQuery(() => query([{ type: "assistant", message: {
			content: [{ type: "text", text: "Assistant summary" }], usage: { input_tokens: 8, output_tokens: 2 },
		} }]));
		const result = await summary().result();
		expect(result.content).toStrictEqual([{ type: "text", text: "Assistant summary" }]);
		expect(result.usage.totalTokens).toBe(10);
	});

	it("retains reported usage on a failed result", async () => {
		runtime.setQuery(() => query([{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["fixture error"], usage: { input_tokens: 4 } }]));
		const result = await summary().result();
		expect(result.stopReason).toBe("error");
		expect(result.usage.input).toBe(4);
		expect(result.errorMessage).toMatch(/fixture error/);
	});
});

describe("isolated summary cancellation and cleanup", () => {
	it("does not create a query for an already aborted request", async () => {
		const invoke = vi.fn(() => query([success()]));
		runtime.setQuery(invoke);
		const stream = summary({ signal: AbortSignal.abort() });
		const events = [];
		for await (const event of stream) events.push(event);
		expect(invoke).not.toHaveBeenCalled();
		expect(events.map(event => [event.type, event.reason])).toStrictEqual([["error", "aborted"]]);
		expect((await stream.result()).stopReason).toBe("aborted");
	});

	it.each([false, true])("classifies iterator failure with aborted=%s and closes the query", async aborted => {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const close = vi.fn();
		const interrupt = vi.fn(async () => {});
		runtime.setQuery(() => Object.assign((async function* () {
			if (aborted) controller.abort();
			throw new Error("transport closed");
		})(), { close, interrupt }));
		const stream = summary({ signal: controller.signal });
		const events = [];
		for await (const event of stream) events.push(event);
		const reason = aborted ? "aborted" : "error";
		expect(events.map(event => [event.type, event.reason])).toStrictEqual([["error", reason]]);
		expect((await stream.result()).stopReason).toBe(reason);
		expect(close).toHaveBeenCalled();
		expect(interrupt).toHaveBeenCalledTimes(aborted ? 1 : 0);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("classifies cancellation during query creation even if creation throws", async () => {
		const controller = new AbortController();
		runtime.setQuery(() => {
			controller.abort();
			throw new Error("launch canceled");
		});
		expect((await summary({ signal: controller.signal }).result()).stopReason).toBe("aborted");
	});

	it.each([
		{ name: "empty", messages: [] },
		{ name: "successful", messages: [success()] },
	])("closes the query and detaches cancellation on $name iterator exit", async ({ messages }) => {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const close = vi.fn();
		const sdkQuery = query(messages, close);
		runtime.setQuery(() => sdkQuery);
		const result = await summary({ signal: controller.signal }).result();
		expect(result.stopReason).toBe(messages.length ? "stop" : "error");
		expect(close).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		controller.abort();
		expect(sdkQuery.interrupt).not.toHaveBeenCalled();
	});
});
