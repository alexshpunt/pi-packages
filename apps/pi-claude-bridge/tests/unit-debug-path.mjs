/**
 * Guards the guard: if tests/lib/setup.mjs stops being preloaded, unit tests
 * would silently start writing to the developer's real debug log instead of a
 * temp dir. That regression is otherwise invisible unless CLAUDE_BRIDGE_DEBUG=1.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { globalConfigPath } from "../src/config.js";
import { debugLogPath, diagLogPath } from "../src/log-paths.js";

describe("test harness", () => {
	it("redirects the bridge debug log away from the real one", () => {
		const path = process.env.CLAUDE_BRIDGE_DEBUG_PATH;
		expect(path, "CLAUDE_BRIDGE_DEBUG_PATH must be set — is tests/lib/setup.mjs still preloaded via --import?").toBeTruthy();
		// Compare against the production default specifically; a blanket "not under
		// $HOME" check would misfire for anyone whose TMPDIR lives inside their home.
		expect(path, "debug log must not resolve to the real one").not.toBe(join(getAgentDir(), "claude-bridge.log"));
	});

	it("keeps every path-derived location inside the temp root", () => {
		const root = process.env.HOME;
		expect(root, "HOME must be set — is tests/lib/setup.mjs still preloaded via --import?").toBeTruthy();
		for (const path of [homedir(), getAgentDir(), globalConfigPath(), debugLogPath(), diagLogPath()]) {
			expect(path.startsWith(root), `${path} must live under ${root}`).toBeTruthy();
		}
	});

	it("resolves lazily from env changes made after import", () => {
		// Pinning the lazy contract: if log-paths regresses to import-time consts,
		// this fails because the preloaded values would still be returned.
		const previous = { agent: process.env.PI_CODING_AGENT_DIR, debug: process.env.CLAUDE_BRIDGE_DEBUG_PATH };
		try {
			process.env.PI_CODING_AGENT_DIR = "/tmp/log-paths-lazy-probe";
			process.env.CLAUDE_BRIDGE_DEBUG_PATH = "/tmp/log-paths-lazy-probe-debug.log";
			expect(diagLogPath()).toBe("/tmp/log-paths-lazy-probe/claude-bridge-diag.log");
			expect(debugLogPath()).toBe("/tmp/log-paths-lazy-probe-debug.log");
		} finally {
			if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous.agent;
			if (previous.debug === undefined) delete process.env.CLAUDE_BRIDGE_DEBUG_PATH;
			else process.env.CLAUDE_BRIDGE_DEBUG_PATH = previous.debug;
		}
	});
});

describe("README manual log cleanup", () => {
	afterEach(() => vi.unstubAllEnvs());

	describe.each([
		{ name: "default", value: "" },
		{ name: "absolute", value: "absolute" },
		{ name: "home only", value: "~" },
		{ name: "home subdirectory", value: "~/custom agent" },
	])("with $name agent directory", ({ value }) => {
		it.each([false, true])("removes only logs with debug path override=%s", overridden => {
			const root = mkdtempSync(join(tmpdir(), "bridge cleanup-"));
			try {
				vi.stubEnv("HOME", root);
				vi.stubEnv("PI_CODING_AGENT_DIR", value === "absolute" ? join(root, "agent") : value);
				vi.stubEnv("CLAUDE_BRIDGE_DEBUG_PATH", overridden ? join(root, "custom", "debug.log") : "");
				const agent = getAgentDir();
				const debug = debugLogPath();
				const cli = join(dirname(debug), "cc-cli-logs");
				const logs = [debug, diagLogPath(), join(cli, "query.log")];
				const kept = [
					join(agent, "claude-bridge.json"),
					join(root, "claude", "projects", "fixture.jsonl"),
					join(cli, "keep.txt"),
					join(cli, "nested", "keep.log"),
				];
				for (const path of [...logs, ...kept]) {
					expect(path.startsWith(root), "fixture must stay inside its isolated HOME").toBe(true);
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, "fixture");
				}
				const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
				const script = readme.split("### Manual log cleanup")[1].match(/```bash\n([\s\S]*?)```/)[1];
				execFileSync("bash", ["-eu", "-c", script], { cwd: root, env: process.env });
				for (const path of logs) expect(existsSync(path), path).toBe(false);
				for (const path of kept) expect(readFileSync(path, "utf8"), path).toBe("fixture");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	});
});

describe("log paths", () => {
	it("follow PI_CODING_AGENT_DIR when no debug path override is set", () => {
		// Read from a fresh process: this is the env the preload sets, minus the
		// debug-path override, resolved against a probe agent dir.
		const env = { ...process.env, PI_CODING_AGENT_DIR: "/tmp/pi-agent-dir-probe" };
		delete env.CLAUDE_BRIDGE_DEBUG_PATH;
		const src = new URL("../src/log-paths.ts", import.meta.url).href;
		const out = execFileSync(process.execPath, [
			"--import", "tsx", "--input-type=module", "-e",
			`const p = await import(${JSON.stringify(src)}); console.log(JSON.stringify({ DEBUG_LOG_PATH: p.debugLogPath(), DIAG_LOG_PATH: p.diagLogPath() }));`,
		], { env, encoding: "utf8" });
		expect(JSON.parse(out)).toStrictEqual({
			DEBUG_LOG_PATH: "/tmp/pi-agent-dir-probe/claude-bridge.log",
			DIAG_LOG_PATH: "/tmp/pi-agent-dir-probe/claude-bridge-diag.log",
		});
	});
});
