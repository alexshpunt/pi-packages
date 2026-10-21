#!/usr/bin/env node
// Unit tests for pi→Anthropic message conversion (convert.ts).

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, repairToolPairing } from "cc-session-io";
import { sanitizeToolId, convertPiMessages, matchLiveToolResultKeyOrder } from "../src/convert.js";

/** Shorthand: convert pi messages and return just the anthropic messages. */
function convert(messages, customToolNameToSdk) {
	return convertPiMessages(messages, customToolNameToSdk).anthropicMessages;
}

const textBlocks = (text) => [{ type: "text", text }];

// --- Tests ---

describe("tool ID sanitization", () => {
	it("Kimi-style IDs with dots and colons", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "functions.bash:0", name: "bash", arguments: { cmd: "ls" } }] },
			{ role: "toolResult", toolCallId: "functions.bash:0", content: "file.txt" },
		];
		const result = convert(msgs);
		expect(result[0].content[0].id).toBe("functions_bash_0");
		expect(result[1].content[0].tool_use_id).toBe("functions_bash_0");
	});

	it("IDs with spaces and special chars", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "tool call#1@foo", name: "bash", arguments: {} }] },
			{ role: "toolResult", toolCallId: "tool call#1@foo", content: "ok" },
		];
		const result = convert(msgs);
		expect(result[0].content[0].id).toBe("tool_call_1_foo");
		expect(result[1].content[0].tool_use_id).toBe("tool_call_1_foo");
	});

	it("already-valid Anthropic IDs pass through unchanged", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "toolu_abc123-XYZ", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "toolu_abc123-XYZ", content: "data" },
		];
		const result = convert(msgs);
		expect(result[0].content[0].id).toBe("toolu_abc123-XYZ");
		expect(result[1].content[0].tool_use_id).toBe("toolu_abc123-XYZ");
	});

	it("tool_use and tool_result IDs stay paired after sanitization", () => {
		const ids = ["fn.read:0", "fn.write:1", "fn.bash:2"];
		const msgs = [];
		for (const id of ids) {
			msgs.push({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: {} }] });
			msgs.push({ role: "toolResult", toolCallId: id, content: "ok" });
		}
		const result = convert(msgs);
		for (let i = 0; i < ids.length; i++) {
			const useId = result[i * 2].content[0].id;
			const resultId = result[i * 2 + 1].content[0].tool_use_id;
			expect(useId, `pair ${i}: tool_use=${useId} tool_result=${resultId}`).toBe(resultId);
		}
	});
});

describe("empty text block filtering", () => {
	it("assistant with empty text + toolCall → only toolCall", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "text", text: "" },
				{ type: "toolCall", id: "abc", name: "read", arguments: {} },
			]},
		];
		const result = convert(msgs);
		expect(result.length).toBe(1);
		expect(result[0].content.length).toBe(1);
		expect(result[0].content[0].type).toBe("tool_use");
	});

	it("assistant with only empty text → placeholder", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "text", text: "" }] },
		];
		const result = convert(msgs);
		expect(result.length).toBe(1);
		expect(result[0].content[0].text).toBe("[incompatible content omitted]");
	});

	it("assistant with non-empty text → preserved", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "text", text: "Hello world" }] },
		];
		const result = convert(msgs);
		expect(result.length).toBe(1);
		expect(result[0].content[0].text).toBe("Hello world");
	});

	it("assistant with multiple text blocks, some empty", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "text", text: "" },
				{ type: "text", text: "real content" },
				{ type: "text", text: "" },
			]},
		];
		const result = convert(msgs);
		expect(result.length).toBe(1);
		expect(result[0].content.length).toBe(1);
		expect(result[0].content[0].text).toBe("real content");
	});
});

describe("thinking block filtering", () => {
	it("non-Anthropic provider thinking blocks dropped", () => {
		const msgs = [
			{ role: "assistant", provider: "openrouter", content: [
				{ type: "thinking", thinking: "let me think..." },
				{ type: "text", text: "answer" },
			]},
		];
		const result = convert(msgs);
		expect(result.length).toBe(1);
		expect(result[0].content.length).toBe(1);
		expect(result[0].content[0].type).toBe("text");
	});

	it("Anthropic provider thinking with signature preserved", () => {
		const msgs = [
			{ role: "assistant", provider: "claude-bridge", content: [
				{ type: "thinking", thinking: "reasoning...", thinkingSignature: "sig123" },
				{ type: "text", text: "answer" },
			]},
		];
		const result = convert(msgs);
		expect(result[0].content.length).toBe(2);
		expect(result[0].content[0].type).toBe("thinking");
		expect(result[0].content[0].signature).toBe("sig123");
	});

	// A signature minted by another provider isn't ours to replay into Claude
	// Code's session, so it is dropped even though the message is Anthropic's.
	it("thinking from pi's own Anthropic provider is dropped", () => {
		const msgs = [
			{ role: "assistant", provider: "anthropic", api: "anthropic-messages", content: [
				{ type: "thinking", thinking: "hmm", thinkingSignature: "sig456" },
				{ type: "text", text: "done" },
			]},
		];
		const result = convert(msgs);
		expect(result[0].content).toStrictEqual([{ type: "text", text: "done" }]);
	});

	it("Anthropic provider thinking WITHOUT signature → dropped", () => {
		const msgs = [
			{ role: "assistant", provider: "claude-bridge", content: [
				{ type: "thinking", thinking: "no sig" },
				{ type: "text", text: "answer" },
			]},
		];
		const result = convert(msgs);
		expect(result[0].content.length).toBe(1);
		expect(result[0].content[0].type).toBe("text");
	});

	it("assistant with only thinking (non-Anthropic) → placeholder", () => {
		const msgs = [
			{ role: "assistant", provider: "deepseek", content: [
				{ type: "thinking", thinking: "deep thoughts" },
			]},
		];
		const result = convert(msgs);
		expect(result.length).toBe(1);
		expect(result[0].content[0].text).toBe("[incompatible content omitted]");
	});
});

describe("message structure", () => {
	it("toolResult → user with tool_result content", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "id1", content: "result text", isError: false },
		];
		const result = convert(msgs);
		expect(result[0].role).toBe("user");
		expect(result[0].content[0].type).toBe("tool_result");
		expect(result[0].content[0].tool_use_id).toBe("id1");
		expect(result[0].content[0].content).toStrictEqual(textBlocks("result text"));
		expect(Object.hasOwn(result[0].content[0], "is_error")).toBe(false);
	});

	it("toolResult with isError=true", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "id1", content: "oh no", isError: true },
		];
		expect(convert(msgs)[0].content[0].is_error).toBe(true);
	});

	// Claude Code puts every result for one assistant turn in a single user
	// message — see the parallel-tool-call tests below for why it matters.
	it("merges the results of a parallel tool call into one user message", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
				{ type: "toolCall", id: "t2", name: "read", arguments: { path: "b.txt" } },
			]},
			{ role: "toolResult", toolCallId: "t1", content: "content a" },
			{ role: "toolResult", toolCallId: "t2", content: "content b" },
		];
		const result = convert(msgs);
		expect(result.length).toBe(2);
		expect(result[0].content.length).toBe(2);
		expect(result[1].role).toBe("user");
		expect(result[1].content.map((b) => [b.tool_use_id, b.content])).toStrictEqual([["t1", textBlocks("content a")], ["t2", textBlocks("content b")]]);
	});

	it("does not merge results across an intervening user message", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "t1", content: "a" },
			{ role: "user", content: "keep going" },
			{ role: "assistant", content: [{ type: "toolCall", id: "t2", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "t2", content: "b" },
		];
		expect(convert(msgs).map((m) => m.role)).toStrictEqual(["assistant", "user", "user", "assistant", "user"]);
	});

	it("mixed conversation: user → assistant(tool) → toolResult → assistant(text)", () => {
		const msgs = [
			{ role: "user", content: "read file.txt" },
			{ role: "assistant", content: [
				{ type: "toolCall", id: "call1", name: "read", arguments: { path: "file.txt" } },
			]},
			{ role: "toolResult", toolCallId: "call1", content: "hello world" },
			{ role: "assistant", content: [{ type: "text", text: "The file says hello world." }] },
		];
		const result = convert(msgs);
		expect(result.length).toBe(4);
		expect(result[0].role).toBe("user");
		expect(result[0].content).toBe("read file.txt");
		expect(result[1].role).toBe("assistant");
		expect(result[1].content[0].type).toBe("tool_use");
		expect(result[1].content[0].name).toBe("mcp__custom-tools__read");
		expect(result[2].role).toBe("user");
		expect(result[2].content[0].type).toBe("tool_result");
		expect(result[3].role).toBe("assistant");
		expect(result[3].content[0].text).toBe("The file says hello world.");
	});

	it("user string content", () => {
		expect(convert([{ role: "user", content: "hello" }])[0].content).toBe("hello");
	});

	it("user empty string → [empty]", () => {
		expect(convert([{ role: "user", content: "" }])[0].content).toBe("[empty]");
	});

	it("user with array content containing text blocks", () => {
		const result = convert([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
		expect(result[0].content).toStrictEqual([{ type: "text", text: "hi" }]);
	});

	it("user with empty text blocks in array → [image] fallback", () => {
		expect(convert([{ role: "user", content: [{ type: "text", text: "" }] }])[0].content).toBe("[image]");
	});

	// With a tool map the query runs `tools: []`, so no name in the transcript may
	// look like a Claude Code builtin — that is what makes the model call one it
	// cannot call. A tool missing from the map is one pi ran and we no longer
	// serve (for example a disabled extension), not a builtin.
	it("tool name mapping: unserved pi tools keep the MCP namespace", () => {
		const served = new Map([["read", "mcp__custom-tools__read"]]);
		const msgs = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "a", name: "read", arguments: {} },
				{ type: "toolCall", id: "b", name: "bash", arguments: {} },
				{ type: "toolCall", id: "c", name: "LegacyTool", arguments: {} },
			]},
		];
		expect(convert(msgs, served)[0].content.map((b) => b.name)).toStrictEqual(["mcp__custom-tools__read", "mcp__custom-tools__bash", "mcp__custom-tools__LegacyTool"]);
	});

	it("tool name mapping: an SDK name in pi history is a double mapping, not a tool", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "a", name: "mcp__custom-tools__bash", arguments: {} }] },
		];
		expect(() => convert(msgs)).toThrow(/already an SDK tool name/);
		expect(() => convert(msgs, new Map())).toThrow(/already an SDK tool name/);
	});

	it("tool name mapping: pi names use MCP even without a served-tool map", () => {
		const msgs = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "a", name: "read", arguments: {} },
				{ type: "toolCall", id: "b", name: "bash", arguments: {} },
			]},
		];
		const result = convert(msgs);
		expect(result[0].content[0].name).toBe("mcp__custom-tools__read");
		expect(result[0].content[1].name).toBe("mcp__custom-tools__bash");
	});

	it("toolResult with array content preserves separate text blocks", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "x", content: [
				{ type: "text", text: "line 1" },
				{ type: "text", text: "line 2" },
			]},
		];
		expect(convert(msgs)[0].content[0].content).toStrictEqual([...textBlocks("line 1"), ...textBlocks("line 2")]);
	});

	// Claude Code stores screenshots as image blocks inside tool_result.content;
	// flattening to text would drop them from a rebuilt session.
	it("toolResult keeps image blocks instead of flattening to text", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "x", content: [
				{ type: "text", text: "captured" },
				{ type: "image", data: "BASE64DATA", mimeType: "image/png" },
			]},
		];
		const result = convert(msgs)[0].content[0].content;
		expect(result).toStrictEqual([
			{ type: "text", text: "captured" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "BASE64DATA" } },
		]);
	});

	// Pi results reach CC through MCP, which retains successful text as blocks.
	it("toolResult without an image keeps the live MCP block shape", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "x", content: [{ type: "text", text: "just text" }] },
		];
		expect(convert(msgs)[0].content[0].content).toStrictEqual(textBlocks("just text"));
	});

	it("toolResult drops unsupported blocks exactly as the live MCP path does", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "x", content: [
				{ type: "document" },
				{ type: "image", data: "BASE64DATA", mimeType: "image/png" },
			]},
		];
		const result = convert(msgs)[0].content[0].content;
		expect(result).toStrictEqual([
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "BASE64DATA" } },
		]);
	});

	it("toolResult with only an image keeps the image", () => {
		const msgs = [
			{ role: "toolResult", toolCallId: "x", content: [
				{ type: "image", data: "BASE64DATA", mimeType: "image/png" },
			]},
		];
		const result = convert(msgs)[0].content[0].content;
		expect(result).toStrictEqual([
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "BASE64DATA" } },
		]);
	});
});

describe("live MCP result contracts", () => {
	it("uses CC's empty-result note with the exact served name", () => {
		for (const content of ["", [], [{ type: "text", text: "" }]]) {
			const converted = convert([
				{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "Probe", arguments: {} }] },
				{ role: "toolResult", toolCallId: "t1", content },
			], new Map([["Probe", "mcp__custom-tools__Probe"]]));
			expect(converted[1].content[0].content).toBe("(mcp__custom-tools__Probe completed with no output)");
			expect(Object.hasOwn(converted[1].content[0], "is_error")).toBe(false);
		}
	});
	it("keeps failed MCP results as text without unsupported-block markers", () => {
		const converted = convert([{ role: "toolResult", toolCallId: "t1", isError: true,
			content: [{ type: "text", text: "failed" }, { type: "resource" }, { type: "text", text: "again" }] }]);
		expect(converted[0].content[0].content).toBe("failed\nagain");
		expect(converted[0].content[0].is_error).toBe(true);
	});
	it("writes CC's success/error key order through cc-session-io to the final JSONL", () => {
		const root = mkdtempSync(join(tmpdir(), "bridge-result-order-"));
		try {
			const session = createSession({ projectPath: root, claudeDir: join(root, "claude") });
			session.importMessages(convert([
				{ role: "assistant", content: [{ type: "toolCall", id: "ok", name: "read", arguments: {} }, { type: "toolCall", id: "bad", name: "read", arguments: {} }] },
				{ role: "toolResult", toolCallId: "ok", content: "value" },
				{ role: "toolResult", toolCallId: "bad", content: "failure", isError: true },
			]));
			matchLiveToolResultKeyOrder(session.records);
			const once = JSON.stringify(session.records);
			matchLiveToolResultKeyOrder(session.records);
			expect(JSON.stringify(session.records)).toBe(once);
			session.save();
			const records = readFileSync(session.jsonlPath, "utf8").trim().split("\n").map(JSON.parse);
			const results = records.find(record => record.type === "user").message.content;
			expect(Object.keys(results[0])).toStrictEqual(["tool_use_id", "type", "content"]);
			expect(Object.keys(results[1])).toStrictEqual(["type", "content", "is_error", "tool_use_id"]);
			expect(results[0].content).toStrictEqual(textBlocks("value"));
			expect(results[1].content).toBe("failure");
			expect(results[1].is_error).toBe(true);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});

// Every rebuild runs the conversion through repairToolPairing — once here, once
// more inside Session.importMessages. It only pairs results that sit in the user
// message directly after their assistant message, so anything the conversion
// leaves in a later message is dropped and replaced with a synthetic
// "[no tool result recorded]" error. That silently destroyed the output of every
// parallel tool call in the rebuilt session.
describe("conversion survives repairToolPairing", () => {
	const parallelCall = (n) => {
		const ids = Array.from({ length: n }, (_, i) => `t${i}`);
		return [
			{ role: "user", content: "read them all" },
			{ role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } })) },
			...ids.map((id) => ({ role: "toolResult", toolCallId: id, content: `body of ${id}` })),
		];
	};

	it("keeps every result of a parallel tool call", () => {
		const converted = convert(parallelCall(3));
		const repaired = repairToolPairing(converted);

		expect(repaired).toStrictEqual(converted);
		const results = repaired.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result");
		expect(results.map((b) => b.content)).toStrictEqual(["body of t0", "body of t1", "body of t2"].map(textBlocks));
	});

	// Mid-turn steering puts a user message between the results (which is why
	// extractAllToolResults walks past them), so adjacency alone is not enough to
	// keep a parallel call together. CC writes the same turn as results-then-steer.
	it("collects results that a steer interleaved, keeping the steer after them", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "t0", name: "read", arguments: {} }, { type: "toolCall", id: "t1", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "t0", content: "first" },
			{ role: "user", content: "actually, also check X" },
			{ role: "toolResult", toolCallId: "t1", content: "second" },
		];
		const repaired = repairToolPairing(convert(msgs));

		expect(repaired.map((m) => m.role)).toStrictEqual(["assistant", "user", "user"]);
		expect(repaired[1].content.map((b) => b.content)).toStrictEqual(["first", "second"].map(textBlocks));
		expect(repaired[2].content).toBe("actually, also check X");
	});

	// A steer sent while the first tool is still running lands in pi's history
	// before any result. repairToolPairing hands the turn's stubs to the first user
	// message after the assistant, so the results have to be inserted ahead of it.
	it("collects results that a steer preceded", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", id: "t0", name: "read", arguments: {} }, { type: "toolCall", id: "t1", name: "read", arguments: {} }] },
			{ role: "user", content: "actually stop and check X" },
			{ role: "toolResult", toolCallId: "t0", content: "first" },
			{ role: "toolResult", toolCallId: "t1", content: "second" },
		];
		const repaired = repairToolPairing(convert(msgs));

		expect(repaired.map((m) => m.role)).toStrictEqual(["assistant", "user", "user"]);
		expect(repaired[1].content.map((b) => b.content)).toStrictEqual(["first", "second"].map(textBlocks));
		expect(repaired[2].content).toBe("actually stop and check X");
	});

	it("leaves no synthetic result stubs behind", () => {
		const repaired = repairToolPairing(convert(parallelCall(5)));

		const stubs = repaired.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.filter((b) => b.type === "tool_result" && typeof b.content === "string" && b.content.includes("no tool result recorded"));
		expect(stubs).toStrictEqual([]);
	});
});

describe("aborted assistant turns", () => {
	it("a turn aborted before anything streamed is dropped, not fabricated", () => {
		const result = convert([
			{ role: "user", content: [{ type: "text", text: "first ask" }] },
			{ role: "assistant", content: [] },
			{ role: "user", content: [{ type: "text", text: "second ask" }] },
		]);
		expect(result.length).toBe(2);
		expect(result.map((m) => m.role)).toStrictEqual(["user", "user"]);
	});

	it("a turn whose blocks were all filtered still says so", () => {
		const result = convert([
			{ role: "assistant", provider: "deepseek", content: [{ type: "thinking", thinking: "deep thoughts" }] },
		]);
		expect(result.length).toBe(1);
		expect(result[0].content[0].text).toBe("[incompatible content omitted]");
	});

	// The prompt cache is keyed on exact prefix bytes, so a rebuild must reproduce
	// the sequence Claude Code already cached. An aborted turn contributes nothing
	// live, so standing a placeholder in for it on rebuild diverged at that index
	// and cost every downstream cached token. See eli/todos.md.
	it("rebuilding across an aborted turn preserves the cached prefix", () => {
		const live = convert([
			{ role: "user", content: [{ type: "text", text: "first ask" }] },
			{ role: "user", content: [{ type: "text", text: "second ask" }] },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		]);
		const rebuilt = convert([
			{ role: "user", content: [{ type: "text", text: "first ask" }] },
			{ role: "assistant", content: [] },
			{ role: "user", content: [{ type: "text", text: "second ask" }] },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		]);
		expect(rebuilt).toStrictEqual(live);
	});

	it("a result stranded after an aborted turn still lands on the real assistant", () => {
		const result = convert([
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
			{ role: "assistant", content: [] },
			{ role: "toolResult", toolCallId: "t1", content: "ok" },
		]);
		expect(result.map((m) => m.role)).toStrictEqual(["assistant", "user"]);
		expect(result[1].content[0].tool_use_id).toBe("t1");
	});
});

describe("dropped-content accounting", () => {
	it("counts stripped thinking by provider and aborted turns", () => {
		const { dropped } = convertPiMessages([
			{ role: "assistant", provider: "openrouter", content: [
				{ type: "thinking", thinking: "reasoning" },
				{ type: "text", text: "the answer" },
			]},
			{ role: "assistant", content: [] },
			{ role: "assistant", provider: "claude-bridge", content: [
				{ type: "thinking", thinking: "mine", thinkingSignature: "sig" },
			]},
		]);
		expect(dropped.thinking).toBe(1);
		expect([...dropped.providers]).toStrictEqual(["openrouter"]);
		expect(dropped.abortedTurns).toBe(1);
	});

	it("reports nothing when everything converts", () => {
		const { dropped } = convertPiMessages([
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
		]);
		expect(dropped.thinking).toBe(0);
		expect(dropped.abortedTurns).toBe(0);
		expect(dropped.other.size).toBe(0);
	});
});
