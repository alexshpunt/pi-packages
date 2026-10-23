import { afterEach, describe, expect, it } from "vitest";
import { Effect, Fiber, Scope } from "effect";
import { createBridgeHarness } from "../tools/verify/bridge-runtime.js";
import { Configuration } from "../src/configuration/service.js";
import { QueryRegistry } from "../src/features/query/registry.js";
import { SessionStore } from "../src/features/session/mirror-store.js";
import { acquireQueryMessages } from "../src/adapters/claude/messages.js";
import { MCP_TOOL_PREFIX } from "../src/features/prompt/skills.js";

const instances = [];
const servers = [];
function harness() {
	const instance = createBridgeHarness();
	instance.setQuery(() => { throw new Error("No fake query installed"); });
	instances.push(instance);
	return instance;
}
afterEach(async () => {
	for (const instance of instances.splice(0)) {
		for (const context of instance.activeQueryContexts) context.bindRunSignal?.(AbortSignal.abort());
		instance.withdrawRebuildHook();
		instance.withdrawReleaseHook();
		await instance.runtime.dispose();
	}
	for (const server of servers.splice(0)) await server.instance.close();
});
const user = { role: "user", content: "fixture", timestamp: 0 };

async function connectToolClient(server) {
	const pending = new Map();
	const transport = {
		start: async () => {},
		close: async () => {},
		send: async message => { pending.get(message.id)?.(message); pending.delete(message.id); },
	};
	await server.instance.connect(transport);
	servers.push(server);
	let id = 0;
	const request = (method, params) => new Promise(resolve => {
		pending.set(++id, resolve);
		transport.onmessage({ jsonrpc: "2.0", id, method, params });
	});
	await request("initialize", {
		protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scope-fixture", version: "1.0.0" },
	});
	transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	return (toolCallId) => request("tools/call", { name: "alpha", arguments: {}, _meta: { "claudecode/toolUseId": toolCallId } });
}

describe("Effect-owned bridge lifetimes", () => {
	it("builds shared services once per instance without sharing mutable session state", () => {
		const first = harness(), second = harness();
		expect(first.runtime.runSync(Configuration)).toBe(first.runtime.runSync(Configuration));
		expect(first.runtime.runSync(QueryRegistry)).toBe(first.runtime.runSync(QueryRegistry));
		expect(first.runtime.runSync(Configuration)).not.toBe(second.runtime.runSync(Configuration));
		const sessions = first.runtime.runSync(SessionStore);
		const state = { sessionId: "cc-first", cursor: 0, cwd: process.cwd() };
		sessions.setSessionStateFor("owner", state);
		expect(sessions.sessionStateFor("owner")).toBe(state);
		expect(second.runtime.runSync(SessionStore).sessionStateFor("owner")).toBeNull();
	});

	it("keeps synchronous SDK setup failures as the original thrown error", () => {
		const runtime = harness();
		const error = new Error("fixture SDK setup failed");
		runtime.setQuery(() => { throw error; });
		let caught;
		try { runtime.streamClaudeAgentSdk(runtime.MODELS[0], { messages: [user] }, { sessionId: "setup" }); }
		catch (cause) { caught = cause; }
		expect(caught).toBe(error);
		expect(runtime.activeQueryContexts.size).toBe(0);
	});

	it.each([
		{ isAlreadyAborted: false, hasSteer: false },
		{ isAlreadyAborted: true, hasSteer: false },
		{ isAlreadyAborted: false, hasSteer: true },
		{ isAlreadyAborted: true, hasSteer: true },
	])("keeps the query scope and transfers cancellation (pre-aborted=$isAlreadyAborted, steer=$hasSteer)", async ({ isAlreadyAborted, hasSteer }) => {
		const runtime = harness();
		const oldOwner = new AbortController(), newOwner = new AbortController();
		const gate = Promise.withResolvers();
		let closeCount = 0, queryCount = 0, hasFinalized = false;
		let server;
		const sdk = Object.assign((async function* () {
			yield { type: "assistant", message: { id: "tool-turn", content: [
				{ type: "tool_use", id: "call-one", name: MCP_TOOL_PREFIX + "alpha", input: {} },
			] } };
			await gate.promise;
		})(), {
			interrupt: async () => {},
			close() { closeCount++; gate.resolve(); },
		});
		runtime.setQuery(input => { queryCount++; server = Object.values(input.options.mcpServers)[0]; return sdk; });
		const tools = [{ name: "alpha", description: "fixture", parameters: { type: "object", properties: {} } }];
		const first = runtime.streamClaudeAgentSdk(runtime.MODELS[0], { messages: [user], tools }, { sessionId: "owner", signal: oldOwner.signal });
		const context = runtime.sessionQueryContextFor("owner");
		const execution = context.execution;
		expect(execution).not.toBeNull();
		expect(runtime.activeQueryContexts.has(context)).toBe(true);
		Effect.runSync(Scope.addFinalizer(execution.scope, Effect.sync(() => { hasFinalized = true; })));
		const assistant = await first.result();
		expect(assistant.stopReason).toBe("toolUse");
		expect(hasFinalized).toBe(false);
		expect(execution.phase).toBe("active");
		const callTool = await connectToolClient(server);
		const reply = callTool("call-one");
		await new Promise(setImmediate);
		expect(context.pendingToolCalls.size).toBe(1);
		if (isAlreadyAborted) newOwner.abort();
		const second = runtime.streamClaudeAgentSdk(runtime.MODELS[0], {
			messages: [user, assistant, { role: "toolResult", toolCallId: "call-one", toolName: "alpha", content: [{ type: "text", text: "ok" }], timestamp: 0 },
				...(hasSteer ? [{ ...user, content: "actually stop" }] : [])], tools,
		}, { sessionId: "owner", signal: newOwner.signal });
		if (!isAlreadyAborted) {
			expect(context.execution).toBe(execution);
			expect(context.pendingToolCalls.size).toBe(hasSteer ? 1 : 0);
			oldOwner.abort();
			expect(closeCount).toBe(0);
			expect(execution.phase).toBe("active");
			newOwner.abort();
		}
		const result = await second.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Operation aborted");
		await Effect.runPromise(Fiber.await(execution.fiber));
		expect(hasFinalized).toBe(true);
		expect(execution.phase).toBe("closed");
		expect(execution.reason).toBe("aborted");
		expect(context.bindRunSignal).toBeNull();
		expect(runtime.activeQueryContexts.has(context)).toBe(false);
		expect(queryCount).toBe(1);
		expect(context.pendingToolCalls.size).toBe(0);
		expect(context.pendingResults.size).toBe(0);
		expect((await reply).result.content[0].text).toBe(isAlreadyAborted || hasSteer ? "Operation aborted" : "ok");
	});

	it("closes an interrupted iterator even while next is pending", async () => {
		let returned = false;
		const source = { [Symbol.asyncIterator]: () => ({
			next: () => new Promise(() => {}),
			return: async () => { returned = true; return { done: true }; },
		}) };
		const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () {
			const messages = yield* acquireQueryMessages(source);
			yield* messages.next;
		})));
		await Effect.runPromise(Fiber.interrupt(fiber));
		expect(returned).toBe(true);
	});

	it("retains instance-owned account detection after the initiating query finishes", async () => {
		const runtime = harness();
		const account = Promise.withResolvers();
		runtime.providerSettings = {};
		runtime.longContextSettings = { ...runtime.longContextSettings, plan: "pro" };
		runtime.setQuery(() => Object.assign((async function* () {
			yield { type: "result", subtype: "success", is_error: false, result: "answer" };
		})(), { interrupt: async () => {}, close() {}, accountInfo: () => account.promise }));
		const stream = runtime.streamClaudeAgentSdk(runtime.MODELS[0], { messages: [user] }, { sessionId: "plan" });
		const execution = runtime.sessionQueryContextFor("plan").execution;
		expect((await stream.result()).stopReason).toBe("stop");
		await Effect.runPromise(Fiber.await(execution.fiber));
		expect(execution.phase).toBe("closed");
		account.resolve({ subscriptionType: "max" });
		await new Promise(setImmediate);
		expect(runtime.longContextSettings.plan).toBe("max");
	});
});
