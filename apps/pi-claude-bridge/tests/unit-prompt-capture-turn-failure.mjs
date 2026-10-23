/**
 * A system prompt the bridge refuses to forward fails the turn through the returned
 * stream instead of throwing out of streamSimple: both the unresolvable prompt
 * (resolveOrDerive) and the sendability guard (projectPromptCapture). No query starts
 * and no stream is left claimed, so the next turn is unaffected.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The failure path writes a diag entry to pi's agent dir, which the bridge resolves
// at import time: point it at a throwaway dir so the real diag log is untouched.
// The agent dir itself does not exist yet, so a diag write that cannot create it
// would throw out of streamSimple instead of failing the turn. Debug stays off: with
// CLAUDE_BRIDGE_DEBUG=1 the bridge creates the dir at import and hides that throw.
const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-turn-failure-"));
const agentDir = join(tmpRoot, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.CLAUDE_BRIDGE_DEBUG;
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

const { default: activate, testBridge } = await import("../tools/verify/fixture-entry.js");
const { PI_PREAMBLE } = await import("../src/features/prompt/capture.js");

let providerConfig;
activate({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const model = providerConfig.models[0];
const turn = (systemPrompt) => providerConfig.streamSimple(
	model,
	{ systemPrompt, messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [] },
	{ sessionId: "pi-session" },
);

let queries;
beforeEach(() => {
	queries = 0;
	testBridge.setQuery(() => { queries++; throw new Error("no query should start"); });
});
afterEach(() => testBridge.setQuery(null));

describe("a prompt the bridge refuses", () => {
	it("fails the turn on the stream when no capture accounts for the prompt", async () => {
		const result = await turn("a system prompt no capture boundary recorded").result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/prompt-capture: no capture/);
		expect(queries).toBe(0);
		expect(testBridge.activeQueryContexts.size).toBe(0);
		expect(existsSync(join(agentDir, "claude-bridge-diag.log"))).toBeTruthy();
	});

	it("fails the turn on the stream when the sendability guard refuses the capture", async () => {
		const prompt = `${PI_PREAMBLE}, recorded with pi's harness in its custom prompt.`;
		testBridge.promptCaptures.record(prompt, { custom: prompt, contextFiles: [], skills: [] });
		const result = await turn(prompt).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/prompt-capture: refusing to send this prompt/);
		expect(queries).toBe(0);
	});
});
