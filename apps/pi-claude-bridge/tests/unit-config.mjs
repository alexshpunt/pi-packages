import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lstatSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { claudeCodeSettings, hasRemovedToolEnabled, loadConfig, markStartupNoticeShown, readDetectedPlan, recordDetectedPlan } from "../src/adapters/storage/configuration.js";

function withTempHome(fn) {
	const oldHome = process.env.HOME;
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const home = mkdtempSync(join(tmpdir(), "claude-bridge-home-"));
	try {
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = join(home, "agent");
		return fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(home, { recursive: true, force: true });
	}
}

describe("claudeCodeSettings", () => {
	it("disables auto-memory by default", () => {
		expect(claudeCodeSettings()).toStrictEqual({ autoMemoryEnabled: false });
	});

	it("allows auto-memory to be enabled", () => {
		expect(claudeCodeSettings({ autoMemoryEnabled: true })).toStrictEqual({ autoMemoryEnabled: true });
	});
});

describe("removed tool configuration", () => {
	it("detects only explicit true without exposing or rewriting the old section", () => withTempHome((home) => {
		const cwd = join(home, "project");
		const dir = join(cwd, CONFIG_DIR_NAME);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "claude-bridge.json");
		for (const enabled of [true, false, null, "true", 1]) {
			const contents = JSON.stringify({ askClaude: { enabled } });
			writeFileSync(path, contents);
			expect(hasRemovedToolEnabled(cwd)).toBe(enabled === true);
			expect("askClaude" in loadConfig(cwd)).toBe(false);
			expect(readFileSync(path, "utf8")).toBe(contents);
		}
	}));

	it("honors an explicit project disable over a global legacy enable", () => withTempHome((home) => {
		const cwd = join(home, "project");
		const dir = join(cwd, CONFIG_DIR_NAME);
		mkdirSync(dir, { recursive: true });
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(join(getAgentDir(), "claude-bridge.json"), JSON.stringify({ askClaude: { enabled: true } }));
		expect(hasRemovedToolEnabled(cwd)).toBe(true);
		writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify({ askClaude: { enabled: false } }));
		expect(hasRemovedToolEnabled(cwd)).toBe(false);
	}));
});

describe("loadConfig", () => {
	it.each(["null", "[]", "[1]", "42", "true", '"config"'])("ignores a non-object JSON root %s without overwriting either config", (contents) => withTempHome((home) => {
		const cwd = join(home, "project");
		const projectDir = join(cwd, CONFIG_DIR_NAME);
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(getAgentDir(), { recursive: true });
		const globalPath = join(getAgentDir(), "claude-bridge.json");
		const projectPath = join(projectDir, "claude-bridge.json");
		writeFileSync(globalPath, contents);
		writeFileSync(projectPath, contents);

		expect(loadConfig(cwd)).toStrictEqual({ startupNoticeShown: undefined, provider: {} });
		expect(readDetectedPlan()).toBe(undefined);
		expect(hasRemovedToolEnabled(cwd)).toBe(false);
		markStartupNoticeShown();
		recordDetectedPlan("max");
		expect(readFileSync(globalPath, "utf8")).toBe(contents);
		expect(readFileSync(projectPath, "utf8")).toBe(contents);

		writeFileSync(globalPath, JSON.stringify({ provider: { plan: "max" } }));
		expect(loadConfig(cwd).provider).toStrictEqual({ plan: "max" });
		writeFileSync(globalPath, contents);
		writeFileSync(projectPath, JSON.stringify({ provider: { plan: "pro" } }));
		expect(loadConfig(cwd).provider).toStrictEqual({ plan: "pro" });
	}));

	it("loads project config from Pi's configured project directory", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
			}));

			expect(loadConfig(cwd)).toStrictEqual({
				startupNoticeShown: undefined,
				provider: { plan: "max" },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("merges project config over global config", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "pro", strictMcpConfig: true },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max", autoMemoryEnabled: true },
			}));

			expect(loadConfig(cwd)).toStrictEqual({
				startupNoticeShown: undefined,
				provider: { plan: "max", strictMcpConfig: true, autoMemoryEnabled: true },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("markStartupNoticeShown records today's date without dropping existing settings", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			mkdirSync(globalDir, { recursive: true });
			const path = join(globalDir, "claude-bridge.json");
			writeFileSync(path, JSON.stringify({
				customSetting: { enabled: false },
				provider: { strictMcpConfig: false },
			}));

			expect(markStartupNoticeShown()).toBe(path);
			const written = JSON.parse(readFileSync(path, "utf-8"));
			expect(written.startupNoticeShown).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(written.customSetting).toStrictEqual({ enabled: false });
			expect(written.provider).toStrictEqual({ strictMcpConfig: false });
			expect(loadConfig(cwd).startupNoticeShown).toBe(written.startupNoticeShown);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("markStartupNoticeShown leaves an unparseable config untouched", () => withTempHome(() => {
		const globalDir = getAgentDir();
		mkdirSync(globalDir, { recursive: true });
		const path = join(globalDir, "claude-bridge.json");
		const malformed = '{ "provider": { "plan": "pro" }, }';
		writeFileSync(path, malformed);

		markStartupNoticeShown();
		expect(readFileSync(path, "utf-8"), "a typo must not cost the user their config").toBe(malformed);
	}));

	it("markStartupNoticeShown replaces the config in one step, keeping its mode and a symlink to it", () => withTempHome((home) => {
		const globalDir = getAgentDir();
		mkdirSync(globalDir, { recursive: true });
		const real = join(home, "dotfiles-claude-bridge.json");
		writeFileSync(real, JSON.stringify({ provider: { strictMcpConfig: false } }), { mode: 0o600 });
		const path = join(globalDir, "claude-bridge.json");
		symlinkSync(real, path);
		const before = statSync(real).ino;

		markStartupNoticeShown();
		// A new inode means a reader saw either the old file or the complete new one, never a truncated one.
		expect(statSync(real).ino).not.toBe(before);
		expect(lstatSync(path).isSymbolicLink(), "a dotfile-managed link must stay a link").toBe(true);
		const written = JSON.parse(readFileSync(real, "utf-8"));
		expect(written.startupNoticeShown).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(written.provider).toStrictEqual({ strictMcpConfig: false });
		expect(statSync(real).mode & 0o777).toBe(0o600);
		expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toStrictEqual([]);
		expect(readdirSync(globalDir).filter((name) => name.endsWith(".tmp"))).toStrictEqual([]);
	}));

	it("markStartupNoticeShown creates the config when there is none", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			expect(loadConfig(cwd).startupNoticeShown).toBe(undefined);
			markStartupNoticeShown();
			expect(loadConfig(cwd).startupNoticeShown).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("resolves global config via PI_CODING_AGENT_DIR override, not hardcoded ~/.pi/agent", () => withTempHome(() => {
		const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const oldEnv = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
			}));

			expect(loadConfig(cwd)).toStrictEqual({
				startupNoticeShown: undefined,
				provider: { plan: "max" },
			});
		} finally {
			if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldEnv;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	}));
});
