import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogging } from "../src/logging.js";
import { createBridgeRuntime } from "../src/runtime.js";

let directory;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "bridge-logging-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("CLAUDE_BRIDGE_DEBUG_PATH", join(directory, "bridge.log"));
	vi.stubEnv("CLAUDE_BRIDGE_DEBUG", "1");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe("best-effort logging", () => {
	it("writes debug, diagnostic and CC stderr logs when paths are usable", () => {
		const logger = createLogging();
		logger.debug("fixture", { value: 1 });
		logger.diagDump("fixture", { value: 2 });
		const cli = logger.makeCliDebugOptions("provider");
		expect(cli.debug).toBe(true);
		expect(cli.debugFile.startsWith(join(directory, "cc-cli-logs"))).toBe(true);
		cli.stderr("stderr fixture\n");
		expect(readFileSync(join(directory, "bridge.log"), "utf8")).toMatch(/stderr fixture/);
		expect(JSON.parse(readFileSync(join(directory, "claude-bridge-diag.log"), "utf8"))).toMatchObject({ label: "fixture", value: 2 });
	});

	it.each(["append", "mkdir"])("silently ignores %s failures in debug and diagnostic writes", failure => {
		const log = vi.spyOn(console, "log");
		const error = vi.spyOn(console, "error");
		if (failure === "append") {
			mkdirSync(join(directory, "bridge.log"));
			mkdirSync(join(directory, "claude-bridge-diag.log"));
		} else {
			const file = join(directory, "not-a-directory");
			writeFileSync(file, "fixture");
			vi.stubEnv("PI_CODING_AGENT_DIR", join(file, "agent"));
			vi.stubEnv("CLAUDE_BRIDGE_DEBUG_PATH", join(file, "bridge.log"));
		}
		expect(() => createLogging().debug("fixture")).not.toThrow();
		vi.stubEnv("CLAUDE_BRIDGE_DEBUG", "0");
		expect(() => createLogging().diagDump("fixture", { value: 1 })).not.toThrow();
		expect(log).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});

	it("does not hand the SDK an unusable CLI log directory", () => {
		writeFileSync(join(directory, "cc-cli-logs"), "not-a-directory");
		expect(createLogging().makeCliDebugOptions("provider")).toStrictEqual({});
	});

	it("ignores serialization failures and stderr forwarding failures", () => {
		const logger = createLogging();
		const cli = logger.makeCliDebugOptions("provider");
		const circular = {};
		circular.self = circular;
		expect(() => logger.debug(circular)).not.toThrow();
		expect(() => logger.diagDump("circular", circular)).not.toThrow();
		vi.stubEnv("CLAUDE_BRIDGE_DEBUG_PATH", directory);
		expect(() => cli.stderr("fixture\n")).not.toThrow();
	});

	it("does not prevent extension registration when the debug log is unwritable", async () => {
		vi.stubEnv("CLAUDE_BRIDGE_DEBUG_PATH", directory);
		const { registerBridge } = await import("../src/provider/registration.js");
		const runtime = createBridgeRuntime();
		try {
			expect(() => registerBridge({ on() {}, registerProvider() {} }, runtime)).not.toThrow();
		} finally {
			runtime.withdrawRebuildHook();
			runtime.withdrawReleaseHook();
		}
	});

	it("preserves the original terminal error when diagnostic logging fails", async () => {
		mkdirSync(join(directory, "claude-bridge-diag.log"));
		const runtime = createBridgeRuntime();
		runtime.setQuery(() => { throw new Error("must not launch"); });
		try {
			const stream = runtime.streamClaudeAgentSdk(runtime.MODELS[0], {
				systemPrompt: "Uncaptured prompt", messages: [{ role: "user", content: "fixture", timestamp: 0 }],
			});
			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/prompt/i);
			expect(result.errorMessage).not.toMatch(/EISDIR|must not launch/);
		} finally {
			runtime.withdrawRebuildHook();
			runtime.withdrawReleaseHook();
		}
	});

	it("does not interrupt stream consumption when diagnostic recording fails", async () => {
		vi.stubEnv("CLAUDE_BRIDGE_RECORD_STREAM", directory);
		const runtime = createBridgeRuntime();
		runtime.setQuery(() => Object.assign((async function* () {
			yield { type: "result", subtype: "success", is_error: false, result: "answer" };
		})(), { close() {}, interrupt: async () => {} }));
		try {
			const result = await runtime.streamClaudeAgentSdk(runtime.MODELS[0], {
				messages: [{ role: "user", content: "fixture", timestamp: 0 }],
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toStrictEqual([{ type: "text", text: "answer" }]);
			await new Promise(resolve => setImmediate(resolve));
		} finally {
			runtime.withdrawRebuildHook();
			runtime.withdrawReleaseHook();
		}
	});
});
