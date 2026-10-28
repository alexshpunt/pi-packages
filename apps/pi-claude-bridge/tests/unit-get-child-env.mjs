/**
 * createClaudeBridgeExtension({ getChildEnv }) hands credentials to Claude Code
 * children only. A leak into the host environment, a log, or an error message
 * would reach every other process and record in the session, so each failure
 * path is checked for the value as well as for the missing spawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeHarness } from "../tools/verify/bridge-runtime.js";
import { createSdkQueryClient } from "../src/adapters/claude/client.js";

const SECRET = "fixture-child-secret";
const user = { role: "user", content: "fixture", timestamp: 0 };
const answer = () => Object.assign((async function* () {
	yield { type: "result", subtype: "success", is_error: false, result: "answer" };
})(), { close() {}, interrupt: async () => {} });

let directory;
const runtimes = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "bridge-child-env-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("CLAUDE_BRIDGE_DEBUG_PATH", join(directory, "bridge.log"));
	vi.stubEnv("CLAUDE_BRIDGE_DEBUG", "1");
});
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) {
		runtime.withdrawRebuildHook();
		runtime.withdrawReleaseHook();
		await runtime.runtime.dispose();
	}
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function bridgeWith(getChildEnv) {
	const runtime = createBridgeHarness({ getChildEnv });
	const inputs = [];
	runtime.setQuery(input => { inputs.push(input); return answer(); });
	runtimes.push(runtime);
	const summaryModel = { ...runtime.MODELS[0], api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge" };
	return {
		runtime, inputs,
		provider: () => runtime.streamClaudeAgentSdk(runtime.MODELS[0], { messages: [user] }, { sessionId: "child-env" }),
		summary: () => runtime.isolatedStreamFn(summaryModel, { messages: [user] }, { cacheRetention: "none" }).result(),
	};
}

function logsMention(value) {
	const files = readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
	expect(files.length).toBeGreaterThan(0);
	return files.some(entry => readFileSync(join(entry.parentPath, entry.name), "utf8").includes(value));
}

describe("getChildEnv", () => {
	it("gives each provider and summary child the creator's variables over the bridge's", async () => {
		const purposes = [];
		const bridge = bridgeWith(({ purpose }) => {
			purposes.push(purpose);
			return Object.freeze({ CLAUDE_CODE_OAUTH_TOKEN: SECRET, DISABLE_AUTO_COMPACT: "0", CLAUDECODE: "caller" });
		});
		expect((await bridge.provider().result()).stopReason).toBe("stop");
		expect((await bridge.summary()).stopReason).toBe("stop");
		expect(purposes).toStrictEqual(["provider", "summary"]);
		expect(bridge.inputs).toHaveLength(2);
		for (const { options } of bridge.inputs) {
			expect(options.env).toMatchObject({
				CLAUDE_CODE_OAUTH_TOKEN: SECRET, DISABLE_AUTO_COMPACT: "0", CLAUDECODE: "caller",
				ENABLE_CLAUDEAI_MCP_SERVERS: "0", PATH: process.env.PATH,
			});
			expect(JSON.stringify(options.mcpServers ?? {})).not.toContain(SECRET);
		}
		expect(Object.values(process.env)).not.toContain(SECRET);
		expect(logsMention(SECRET)).toBe(false);
	});

	it.each([
		["throws", () => { throw new Error(SECRET); }, /getChildEnv failed/],
		["throws from a getter", () => ({ get CLAUDE_CODE_OAUTH_TOKEN() { throw new Error(SECRET); } }), /getChildEnv failed/],
		["returns a string", () => SECRET, /plain object of strings/],
		["returns an array", () => [SECRET], /plain object of strings/],
		["returns a promise", () => Promise.resolve({ CLAUDE_CODE_OAUTH_TOKEN: SECRET }), /plain object of strings/],
		["returns a non-string value", () => ({ CLAUDE_CODE_OAUTH_TOKEN: SECRET, PORT: 1 }), /plain object of strings/],
	])("starts no child and reveals no value when getChildEnv %s", async (_case, getChildEnv, message) => {
		const bridge = bridgeWith(getChildEnv);
		let caught;
		try { bridge.provider(); } catch (error) { caught = error; }
		expect(caught?.message).toMatch(message);
		expect(caught.message).not.toContain(SECRET);
		expect(caught.cause).toBeUndefined();
		expect(bridge.runtime.activeQueryContexts.size).toBe(0);

		const summary = await bridge.summary();
		expect(summary.stopReason).toBe("error");
		expect(summary.errorMessage).toMatch(message);
		expect(summary.errorMessage).not.toContain(SECRET);

		expect(bridge.inputs).toHaveLength(0);
		expect(logsMention(SECRET)).toBe(false);
	});

	it("refuses a child without a purpose", () => {
		const client = createSdkQueryClient(() => ({ CLAUDE_CODE_OAUTH_TOKEN: SECRET }));
		const query = vi.fn(answer);
		client.setQuery(query);
		expect(() => client.invokeQuery({ prompt: "fixture", options: {} })).toThrow(/no child purpose/);
		expect(query).not.toHaveBeenCalled();
	});

	it("leaves children unchanged without getChildEnv", async () => {
		const bridge = bridgeWith(undefined);
		expect((await bridge.provider().result()).stopReason).toBe("stop");
		expect(bridge.inputs[0].options.env).toMatchObject({ DISABLE_AUTO_COMPACT: "1", PATH: process.env.PATH });
	});

	it("exports the factory next to the default extension", async () => {
		const bridge = await import("../src/index.js");
		expect(typeof bridge.createClaudeBridgeExtension).toBe("function");
		expect(typeof bridge.createClaudeBridgeExtension({ getChildEnv: () => ({}) })).toBe("function");
		expect(typeof bridge.default).toBe("function");
	});
});
