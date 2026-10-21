/**
 * CC reports API failures (429 capacity, overload, prompt-too-long) as a result with
 * is_error set while subtype stays "success", after streaming the text as a <synthetic>
 * assistant message. The result shape (is_error with subtype "success") is pinned
 * live against the installed SDK in tests/int-cc-contracts.mjs. Without this the
 * turn finalizes as a normal stop and the failure never reaches pi.
 */
import { describe, expect, it } from "vitest";
import { QueryContext } from "../src/provider/query-context.js";

const { __test } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
const toolMap = new Map([["mcp__custom-tools__bash", "bash"]]);

function fakeStream() {
	const events = [];
	return { events, push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
}

function makeCtx() {
	const c = new QueryContext();
	c.currentPiStream = fakeStream();
	c.resetTurnState(fakeModel);
	return c;
}

async function consume(c, messages) {
	async function* gen() { for (const m of messages) yield m; }
	await __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c);
}

const errorResult = {
	type: "result", subtype: "success", is_error: true, api_error_status: 429,
	result: "API Error: Server is temporarily limiting requests (not your usage limit): Rate limited",
	terminal_reason: "model_error",
};

// Shared by the provider turn and the isolated compact summary — the summary path used to
// accept an errored result as a valid summary, writing "Prompt is too long" into history.
describe("resultErrorText", () => {
	it("treats is_error on a success-shaped result as a failure", () => {
		expect(__test.resultErrorText(errorResult)).toBe(errorResult.result);
	});

	it("returns undefined for a genuine success", () => {
		expect(__test.resultErrorText({ type: "result", subtype: "success", is_error: false, result: "a summary" })).toBe(undefined);
	});

	it("joins errors[] for the dedicated error subtypes", () => {
		expect(__test.resultErrorText({ type: "result", subtype: "error_during_execution", errors: ["boom", "bang"] })).toBe("boom\nbang");
	});

	it("never returns an empty message for a failure", () => {
		expect(__test.resultErrorText({ type: "result", subtype: "success", is_error: true, result: "" })).toBeTruthy();
		expect(__test.resultErrorText({ type: "result", subtype: "error_max_budget_usd" })).toBeTruthy();
		// errors[] is typed string[], with no promise of being non-empty; joining an
		// empty one marks the turn errored with nothing to show the user.
		expect(__test.resultErrorText({ type: "result", subtype: "error_during_execution", errors: [] })).toBeTruthy();
	});
});

// pi carries a failure only as errorMessage text, so every consumer that reacts to a rate
// limit pattern-matches it. These mirror pi-subagents' gate (model-fallback.ts): one pattern
// from its retryable list, and the tool-failure shape it refuses to retry.
const RETRYABLE = /rate\s*limit/i;
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

describe("a rate-limited failure", () => {
	// Claude Code words a subscription limit with none of the vocabulary anyone matches on,
	// and sends the rejection as its own message just before the failure it caused.
	const rejection = {
		type: "rate_limit_event",
		rate_limit_info: { status: "rejected", resetsAt: 1786141800, rateLimitType: "five_hour" },
	};
	const limitResult = {
		type: "result", subtype: "success", is_error: true,
		result: "You're out of extra usage \u00b7 resets 6:30pm (America/New_York)",
	};

	it("is named as a rate limit so fallback chains fire", async () => {
		const c = makeCtx();
		await consume(c, [rejection, limitResult]);

		expect(c.turnOutput.errorMessage).toMatch(RETRYABLE);
		expect(c.turnOutput.errorMessage).not.toMatch(TOOL_FAILURE_PREFIX);
		expect(c.turnOutput.errorMessage.includes(limitResult.result), "keeps Claude Code's own wording").toBeTruthy();
		expect(c.turnOutput.errorMessage.includes("five_hour")).toBeTruthy();
	});

	it("labels only the failure it caused, not a later one", async () => {
		const c = makeCtx();
		await consume(c, [rejection, limitResult, errorResult]);

		expect(c.turnOutput.errorMessage).toBe(errorResult.result);
	});

	it("leaves an unrelated failure alone", async () => {
		const c = makeCtx();
		await consume(c, [errorResult]);
		expect(c.turnOutput.errorMessage).toBe(errorResult.result);
	});
});

describe("error results", () => {
	it("marks the turn errored and finalizes with an error event", async () => {
		const c = makeCtx();
		await consume(c, [errorResult]);

		expect(c.turnOutput.stopReason).toBe("error");
		expect(c.turnOutput.errorMessage).toBe(errorResult.result);

		const stream = c.currentPiStream;
		__test.finalizeCurrentStream(c, c.turnOutput.stopReason);
		const terminal = stream.events.at(-2);
		expect(terminal.type).toBe("error");
		expect(terminal.reason).toBe("error");
		expect(terminal.error.errorMessage).toBe(errorResult.result);
	});

	it("does not re-emit text the synthetic assistant message already delivered", async () => {
		const c = makeCtx();
		await consume(c, [
			{ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: errorResult.result }] } },
			errorResult,
		]);

		const texts = c.turnOutput.content.filter((b) => b.type === "text");
		expect(texts.map((b) => b.text)).toStrictEqual([errorResult.result]);
	});

	// A consumer that fails over only before output commits, such as
	// pi-model-fallback-alias, cannot reach the next provider if Claude Code's own
	// failure report counts as output. Such a consumer commits on anything that is
	// not a start or thinking event, so only that prefix may precede the terminal
	// error.
	it("keeps a synthetic report off the stream, so failover is still possible", async () => {
		const c = makeCtx();
		await consume(c, [
			{ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: errorResult.result }] } },
			errorResult,
		]);

		const stream = c.currentPiStream;
		__test.finalizeCurrentStream(c, c.turnOutput.stopReason);

		const beforeTerminal = stream.events.slice(0, -2);
		expect(beforeTerminal.every((e) => e.type === "start" || e.type.startsWith("thinking_")), `synthetic report must not commit output, got: ${stream.events.map((e) => e.type).join(",")}`).toBeTruthy();
		expect(stream.events.at(-2).type).toBe("error");
		expect(stream.events.at(-2).error.errorMessage).toBe(errorResult.result);
		// The wording still reaches pi's transcript as the failed turn's content.
		expect(c.turnOutput.content).toStrictEqual([{ type: "text", text: errorResult.result }]);
	});

	// A stalled stream whose non-streaming retry also fails: the synthetic failure
	// report arrives while the dead stream's partial blocks (unsigned thinking, a tool
	// call CC will never dispatch) are still open. The report must drop them the same
	// way the fallback path does — convertPiMessages would otherwise replay the
	// abandoned tool call as one awaiting a result.
	it("synthetic report after a stalled stream drops the abandoned partial blocks", async () => {
		const c = makeCtx();
		// A stream that reached a thinking block and the start of a tool call, then stalled.
		const stalledStream = (id) => [
			{ type: "stream_event", event: { type: "message_start", message: { id } } },
			{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
			{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me look" } } },
			{ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_dead", input: {} } } },
			{ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"comm" } } },
		];
		await consume(c, [
			...stalledStream("msg_stalled"),
			{ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: errorResult.result }] } },
			errorResult,
		]);

		expect(c.turnOutput.content).toStrictEqual([{ type: "text", text: errorResult.result }]);
		expect(c.turnSawToolCall).toBe(false);
		expect(c.turnStreamOpen).toBe(false);
	});

	it("still streams and finalizes a successful result normally", async () => {
		const c = makeCtx();
		await consume(c, [{ type: "result", subtype: "success", is_error: false, result: "done" }]);

		expect(c.turnOutput.stopReason).toBe("stop");
		expect(c.turnOutput.errorMessage).toBe(undefined);
		expect(c.turnOutput.content).toStrictEqual([{ type: "text", text: "done" }]);

		const stream = c.currentPiStream;
		__test.finalizeCurrentStream(c, c.turnOutput.stopReason);
		expect(stream.events.at(-2).type).toBe("done");
	});

	// A turn that ended on a tool call has already closed its pi stream, and the
	// guard that suppresses content events for a closed stream used to swallow the
	// result message with it — so a 429 mid-tool set no stopReason, no
	// errorMessage, and logged nothing at all.
	it("records a failure that arrives after the turn ended on a tool call", async () => {
		const c = makeCtx();
		c.currentPiStream = null; // what the tool boundary leaves behind

		await consume(c, [errorResult]);

		expect(c.turnOutput.stopReason).toBe("error");
		expect(c.turnOutput.errorMessage).toBe(errorResult.result);
	});

	it("reports the dedicated error subtypes", async () => {
		const c = makeCtx();
		await consume(c, [{ type: "result", subtype: "error_max_turns", is_error: true, errors: ["hit the cap"] }]);

		expect(c.turnOutput.stopReason).toBe("error");
		expect(c.turnOutput.errorMessage).toBe("hit the cap");
	});
});
