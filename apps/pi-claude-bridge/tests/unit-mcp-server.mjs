/**
 * What the bridge puts on the MCP wire: tool schemas must survive verbatim
 * (including below the top level), and tool calls must be paired with Claude's
 * own tool_use id.
 *
 * Drives the MCP server the same way the Agent SDK does — `instance.connect()`
 * with a transport, then raw JSON-RPC — so the assertions cover what Claude
 * actually receives rather than an intermediate representation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createToolServer } from "../src/adapters/claude/mcp-server.js";
import { listPiToolMeta } from "../src/adapters/pi/tool-meta.js";
import { QueryContext } from "../src/features/query/state.js";
import { createToolBridge } from "../src/features/tool-bridge/service.js";

const NESTED_TOOL_SCHEMA = {
	type: "object",
	properties: {
		question: { type: "string", description: "Question to ask" },
		options: {
			type: "array",
			description: "Choices to offer",
			items: {
				type: "object",
				properties: {
					label: { type: "string", description: "Short label" },
					detail: { type: "string" },
				},
				required: ["label"],
			},
		},
		config: {
			type: "object",
			properties: {
				mode: { type: "string", enum: ["single", "multi"] },
				retries: { type: "integer" },
			},
			required: ["mode"],
		},
		either: { anyOf: [{ type: "string" }, { type: "number" }] },
	},
	required: ["question", "options"],
};

// Mirrors the SDK's connectSdkMcpServer: hand the instance a transport, push
// requests into transport.onmessage, read replies out of transport.send.
async function connectClient(server) {
	const pending = new Map();
	const transport = {
		start: async () => {},
		close: async () => {},
		send: async (msg) => pending.get(msg.id)?.(msg),
	};
	await server.instance.connect(transport);

	let nextId = 0;
	const request = (method, params) =>
		new Promise((resolve) => {
			const id = ++nextId;
			pending.set(id, resolve);
			transport.onmessage({ jsonrpc: "2.0", id, method, params });
		});

	// Claude Code identifies the call it is making via _meta on every tools/call.
	const callTool = (name, toolUseId, args = {}) =>
		request("tools/call", {
			name,
			arguments: args,
			...(toolUseId ? { _meta: { "claudecode/toolUseId": toolUseId } } : {}),
		});

	await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "1.0.0" },
	});
	transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	return { request, callTool };
}

describe("MCP tool schema advertisement", () => {
	let listed;

	// A non-object schema typechecks (pi types parameters as any TypeBox schema)
	// but cannot go on the wire. Advertising it as "no arguments" instead would
	// surface much later as pi rejecting the arguments Claude did not send.
	it("rejects a non-object parameter schema at construction, naming the tool", () => {
		expect(() => createToolServer("custom-tools", [
			{ name: "bad_tool", description: "", inputSchema: { type: "string" }, handler: async () => ({ content: [] }) },
		])).toThrow(/bad_tool: MCP tool parameters must be an object schema/);
	});

	beforeAll(async () => {
		const server = createToolServer("custom-tools", [
			{
				name: "ask_user_question",
				description: "Ask the user a question",
				inputSchema: NESTED_TOOL_SCHEMA,
				handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
			},
		]);
		const { request } = await connectClient(server);
		listed = (await request("tools/list", {})).result.tools[0].inputSchema;
	});

	it("preserves top-level properties and required", () => {
		expect(Object.keys(listed.properties).sort()).toStrictEqual(["config", "either", "options", "question"]);
		expect(listed.required).toStrictEqual(["question", "options"]);
		expect(listed.properties.question.description).toBe("Question to ask");
	});

	it("preserves object properties nested in an array", () => {
		const item = listed.properties.options.items;
		expect(Object.keys(item.properties).sort()).toStrictEqual(["detail", "label"]);
		expect(item.required).toStrictEqual(["label"]);
		expect(item.properties.label.description).toBe("Short label");
	});

	it("preserves nested object properties, enums and required", () => {
		const config = listed.properties.config;
		expect(Object.keys(config.properties).sort()).toStrictEqual(["mode", "retries"]);
		expect(config.required).toStrictEqual(["mode"]);
		expect(config.properties.mode.enum).toStrictEqual(["single", "multi"]);
		expect(config.properties.retries.type).toBe("integer");
	});

	it("preserves anyOf branches", () => {
		expect(listed.properties.either.anyOf).toStrictEqual([{ type: "string" }, { type: "number" }]);
	});

	// Without a declared limit, Claude Code saves a result over 50,000 characters
	// to a file and shows Claude a 2KB preview of what pi returned in full.
	it("declares the largest result size Claude Code accepts on every tool", async () => {
		const { request } = await connectClient(createToolServer("custom-tools", [
			{ name: "read", description: "r", inputSchema: { type: "object", properties: {} }, handler: async () => ({ content: [] }) },
			{ name: "bash", description: "b", inputSchema: { type: "object", properties: {} }, handler: async () => ({ content: [] }) },
		]));
		const tools = (await request("tools/list", {})).result.tools;
		expect(tools.map((tool) => tool._meta)).toStrictEqual([
			{ "anthropic/maxResultSizeChars": 500_000 },
			{ "anthropic/maxResultSizeChars": 500_000 },
		]);
	});
});

describe("tool _meta from pi", () => {
	const TOOLS = ["read", "mcp__codemap__grep", "mcp__docs__search"].map((name) => ({
		name,
		description: name,
		parameters: { type: "object", properties: {} },
	}));
	const LIMIT = { "anthropic/maxResultSizeChars": 500_000 };

	/** A pi whose getAllTools() is `allTools` and whose extensions answer `tool-meta` requests with `replies`. */
	function fakePi(allTools, replies = []) {
		const events = createEventBus();
		for (const reply of replies) events.on("tool-meta", (request) => request.reply(reply));
		return { events, getAllTools: allTools };
	}

	/** `_meta` by tool name as Claude Code lists it, when `source` is the bridge's `listPiToolMeta`. */
	async function listedMeta(source) {
		const bridge = createToolBridge({ diagnostics: { DEBUG: false, debug: () => {} }, configuration: { listPiToolMeta: source }, sessions: {} });
		const { request } = await connectClient(Object.values(bridge.buildMcpServers(TOOLS, new QueryContext()))[0]);
		const tools = (await request("tools/list", {})).result.tools;
		return Object.fromEntries(tools.map((tool) => [tool.name, tool._meta]));
	}

	it("passes each tool's _meta on as pi.getAllTools() reports it, over the default limit", async () => {
		const pi = fakePi(() => [
			{ name: "read" },
			{ name: "mcp__codemap__grep", meta: { "anthropic/maxResultSizeChars": 100_000 } },
			{ name: "mcp__docs__search", meta: { "x/key": { nested: [1] }, "pi/maxOutputBytes": 50_000 } },
		]);
		expect(await listedMeta(() => listPiToolMeta(pi))).toStrictEqual({
			read: LIMIT,
			mcp__codemap__grep: { "anthropic/maxResultSizeChars": 100_000 },
			mcp__docs__search: { ...LIMIT, "x/key": { nested: [1] }, "pi/maxOutputBytes": 50_000 },
		});
	});

	// Pi versions without `meta` in getAllTools(): extensions reply on pi.events instead.
	it("passes each tool's _meta on as extensions reply to tool-meta requests", async () => {
		const pi = fakePi(
			() => TOOLS,
			[
				{ mcp__codemap__grep: { "anthropic/maxResultSizeChars": 100_000 } },
				{ mcp__docs__search: { "pi/maxOutputBytes": 50_000 }, ignored: "not an object" },
			],
		);
		expect(await listedMeta(() => listPiToolMeta(pi))).toStrictEqual({
			read: LIMIT,
			mcp__codemap__grep: { "anthropic/maxResultSizeChars": 100_000 },
			mcp__docs__search: { ...LIMIT, "pi/maxOutputBytes": 50_000 },
		});
	});

	it("keeps pi.getAllTools() meta for a tool an extension also replies for", () => {
		const pi = fakePi(
			() => [{ name: "mcp__docs__search", meta: { from: "pi" } }],
			[{ mcp__docs__search: { from: "reply" }, mcp__codemap__grep: { from: "reply" } }],
		);
		expect(Object.fromEntries(listPiToolMeta(pi))).toStrictEqual({
			mcp__docs__search: { from: "pi" },
			mcp__codemap__grep: { from: "reply" },
		});
	});

	// No meta from pi or any extension, no pi, and a pi whose tools cannot be listed.
	it.each([
		["without meta", () => listPiToolMeta(fakePi(() => TOOLS))],
		["absent", undefined],
		["failing", () => listPiToolMeta(fakePi(() => { throw new Error("stale"); }))],
	])("keeps the default limit when pi's tool list is %s", async (_case, source) => {
		expect(await listedMeta(source)).toStrictEqual({ read: LIMIT, mcp__codemap__grep: LIMIT, mcp__docs__search: LIMIT });
	});
});

describe("MCP tool invocation", () => {
	// Two tools, so a handler picked by position rather than by name/id is visible.
	const twoTools = (record) => [
		{
			name: "alpha",
			description: "a",
			inputSchema: { type: "object", properties: {} },
			handler: async (toolCallId) => {
				record.push(["alpha", toolCallId]);
				return { content: [{ type: "text", text: "from alpha" }] };
			},
		},
		{
			name: "beta",
			description: "b",
			inputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
			handler: async (toolCallId) => {
				record.push(["beta", toolCallId]);
				return { content: [{ type: "text", text: "from beta" }], isError: true };
			},
		},
	];

	it("routes tools/call to the matching handler", async () => {
		const calls = [];
		const { callTool } = await connectClient(createToolServer("custom-tools", twoTools(calls)));

		const beta = await callTool("beta", "toolu_b", { x: "hi" });
		expect(calls).toStrictEqual([["beta", "toolu_b"]]);
		expect(beta.result.content[0].text).toBe("from beta");
		expect(beta.result.isError).toBe(true);
	});

	// Claude sends the authoritative tool_use id on every call. Inferring it from
	// call order instead silently pairs a result with the wrong call whenever the
	// order diverges — e.g. parallel tool calls, or a call that never arrives.
	it("hands the handler Claude's tool_use id, not one inferred from call order", async () => {
		const calls = [];
		const { callTool } = await connectClient(createToolServer("custom-tools", twoTools(calls)));

		await callTool("beta", "toolu_second", { x: "hi" });
		await callTool("alpha", "toolu_first");

		expect(calls).toStrictEqual([["beta", "toolu_second"], ["alpha", "toolu_first"]]);
	});

	it("fails loudly when the tool_use id is absent rather than mispairing", async () => {
		const calls = [];
		const { callTool } = await connectClient(createToolServer("custom-tools", twoTools(calls)));

		const res = await callTool("alpha", null);
		const message = res.error?.message ?? JSON.stringify(res.result);
		expect(message).toMatch(/toolUseId/i);
		expect(calls, "handler must not run without an id to pair its result to").toStrictEqual([]);
	});

	// toolCallId is internal bookkeeping for pairing results; it is not part of
	// MCP's CallToolResult and has no business on the wire.
	it("does not leak internal fields into the tool result", async () => {
		const { callTool } = await connectClient(
			createToolServer("custom-tools", [
				{
					name: "alpha",
					description: "a",
					inputSchema: { type: "object", properties: {} },
					handler: async (toolCallId) => ({
						content: [{ type: "text", text: "ok" }],
						isError: false,
						toolCallId,
					}),
				},
			]),
		);

		const res = await callTool("alpha", "toolu_x");
		expect(Object.keys(res.result).sort()).toStrictEqual(["content", "isError"]);
	});

	// A schema-validation rejection would skip the handler entirely, desyncing
	// the result pairing.
	it("invokes the handler even when arguments do not match the schema", async () => {
		let called = false;
		const { callTool } = await connectClient(
			createToolServer("custom-tools", [
				{
					name: "strict",
					description: "s",
					inputSchema: {
						type: "object",
						properties: { count: { type: "number" } },
						required: ["count"],
						additionalProperties: false,
					},
					handler: async () => {
						called = true;
						return { content: [{ type: "text", text: "ran" }] };
					},
				},
			]),
		);

		const res = await callTool("strict", "toolu_y", { count: "not-a-number", extra: 1 });
		expect(called, "handler must run — pi validates and executes tools, not the MCP layer").toBeTruthy();
		expect(res.result.content[0].text).toBe("ran");
	});
});
