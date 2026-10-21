// Standalone runner for the approved legacy integration set of the final
// verification. Not a check: the CLI discovers only checks/, so `verify --all`
// never starts these model-calling integrations, recursively or otherwise.
//
//   node --import tsx tools/verify/run-final-validation.ts --report <path> [--log-dir <empty dir>] [--cache]
//
// --cache runs only the optional cache integration instead of the approved set.
//
// Tests are copied into an owned temporary app whose src and node_modules link to
// this app; .env.test is neither copied nor loaded, so the harnesses' auto-load
// finds nothing. Every integration process shares one fresh log directory, which
// the deadlock gate then scans. Model requests of these integrations are not
// instrumented and are reported as such.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getClaudeDir } from "cc-session-io";
import { assertLiveEnvironment, MODEL_ID } from "./policy.js";
import { isReportSafe, sourceRevision, versions } from "./report.js";
import { VerificationError, type Facts } from "./types.js";
import { withWorkspace } from "./workspace.js";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHELL_TESTS = ["int-multi-turn.sh"];
// Prompt-cache efficiency is an optional measurement, run only with --cache.
const CACHE_SHELL_TESTS = ["int-cache.sh"];
// Outside the approved scope: both need another provider/model from .env.test.
const EXCLUDED_TESTS = { "int-session-resume.mjs": "requires-other-provider", "int-image-session.mjs": "requires-other-provider" };
const STEP_TIMEOUT_MS = 3 * 60 * 60 * 1000;

function approvedNodeTests(): string[] {
	return readdirSync(join(APP_DIR, "tests")).filter(name => /^int-.*\.mjs$/.test(name) && !Object.hasOwn(EXCLUDED_TESTS, name)).sort();
}

function modification(path: string): string | null {
	try { return statSync(path, { bigint: true }).mtimeNs.toString(); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function ccProjectDirs(): string[] {
	const projects = join(getClaudeDir(), "projects");
	return existsSync(projects) ? readdirSync(projects).sort() : [];
}

/** The pi CLI the integrations spawn: the global install, as rpc-harness picks it. */
function piCliVersion(): string | null {
	const path = (process.env.PATH ?? "").split(":").filter(entry => !entry.includes("node_modules")).join(":");
	const run = spawnSync("pi", ["--version"], { encoding: "utf8", env: { ...process.env, PATH: path } });
	return run.status === 0 ? run.stdout.trim() : null;
}

// The shell integrations call GNU `timeout`, which macOS does not ship. When the
// host lacks it, the shell steps get this stand-in: COMMAND runs in its own
// process group, which receives TERM after DURATION; the exit status is then 124.
const TIMEOUT_SHIM = `const { spawn } = require("node:child_process");
const { constants } = require("node:os");
const [duration, command, ...args] = process.argv.slice(2);
const match = /^(\\d+(?:\\.\\d+)?)([smh]?)$/.exec(duration ?? "");
if (!match || !command) { console.error("usage: timeout DURATION COMMAND [ARG]..."); process.exit(125); }
const seconds = Number(match[1]) * ({ "": 1, s: 1, m: 60, h: 3600 })[match[2]];
const child = spawn(command, args, { stdio: "inherit", detached: true });
let isTimedOut = false;
const signalGroup = (signal) => { try { process.kill(-child.pid, signal); } catch {} };
const timer = setTimeout(() => { isTimedOut = true; signalGroup("SIGTERM"); }, seconds * 1000);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => signalGroup(signal));
child.on("error", () => { clearTimeout(timer); process.exit(127); });
child.on("exit", (code, signal) => {
\tclearTimeout(timer);
\tprocess.exit(isTimedOut ? 124 : code ?? 128 + (constants.signals[signal] ?? 0));
});
`;

/** PATH for the shell steps: unchanged when the host has `timeout`, else the shim first. */
function shellPath(binDir: string, path: string): { path: string; timeoutCommand: "system" | "shim" } {
	if (spawnSync("sh", ["-c", "command -v timeout"], { env: { ...process.env, PATH: path } }).status === 0) return { path, timeoutCommand: "system" };
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, "timeout.cjs"), TIMEOUT_SHIM);
	writeFileSync(join(binDir, "timeout"), `#!/bin/sh\nexec node "${join(binDir, "timeout.cjs")}" "$@"\n`);
	chmodSync(join(binDir, "timeout"), 0o755);
	return { path: `${binDir}:${path}`, timeoutCommand: "shim" };
}

function summaryLines(output: string): string[] {
	return output.split("\n")
		.filter(line => /^(?:ℹ (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) |[✔✖] tests\/int-|\s*✖ |PASS\b|FAIL\b|No bridge deadlock warnings|Bridge deadlock warnings|ERROR\b)/.test(line))
		.map(line => line.slice(0, 300));
}

function runStep(label: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logDir: string): Facts {
	const startedMs = Date.now();
	const run = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: STEP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
	const output = (run.stdout ?? "") + (run.stderr ?? "");
	const logFile = join(logDir, `final-step-${label}.out`);
	writeFileSync(logFile, output);
	return {
		label, command: [command, ...args].join(" "), exitCode: run.status, signal: run.signal,
		executionError: run.error ? (run.error as NodeJS.ErrnoException).code ?? "spawn-error" : null,
		durationMs: Date.now() - startedMs, summary: summaryLines(output), outputFile: logFile,
	};
}

async function main(): Promise<number> {
	const { values } = parseArgs({ options: { report: { type: "string" }, "log-dir": { type: "string" }, cache: { type: "boolean" } } });
	if (!values.report) throw new Error("usage: run-final-validation.ts --report <path> [--log-dir <empty dir>] [--cache]");
	assertLiveEnvironment(process.env, MODEL_ID);
	const reportPath = resolve(values.report);
	const logDir = resolve(values["log-dir"] ?? join(APP_DIR, ".test-output/final-validation", new Date().toISOString().replace(/[:.]/g, "-")));
	mkdirSync(logDir, { recursive: true });
	if (readdirSync(logDir).length) throw new Error(`log directory is not empty: ${logDir}`);

	const shellTests = values.cache ? CACHE_SHELL_TESTS : SHELL_TESTS;
	const nodeTests = values.cache ? [] : approvedNodeTests();
	if (!values.cache && !nodeTests.length) throw new Error("no approved integration tests");
	const piSettings = join(homedir(), ".pi/agent/settings.json");
	const before = { sourceRevision: sourceRevision(APP_DIR), piSettings: modification(piSettings), ccProjects: ccProjectDirs() };
	const piCli = piCliVersion();

	// Kept outside the workspace so a failed cleanup check still reports what ran.
	const steps: Facts[] = [];
	let timeoutCommand: string | null = null;
	let integration: Facts = {};
	let failure: Facts | null = null;
	try {
		integration = await withWorkspace(true, async workspace => {
			const app = workspace.cwd;
			for (const file of ["package.json", "tsconfig.json", "vitest.int.config.mjs", "LICENSE"]) cpSync(join(APP_DIR, file), join(app, file));
			for (const dir of ["src", "node_modules"]) symlinkSync(join(APP_DIR, dir), join(app, dir), "dir");
			cpSync(join(APP_DIR, "tests"), join(app, "tests"), { recursive: true });
			if (existsSync(join(app, ".env.test"))) throw new VerificationError("env-test-reached-temporary-app");
			const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_BRIDGE_TEST_LOG_DIR: logDir };
			const shell = shellPath(join(workspace.root, "bin"), env.PATH ?? "");
			timeoutCommand = shell.timeoutCommand;
			for (const file of shellTests) steps.push(runStep(file.replace(/\.sh$/, ""), "bash", [`tests/${file}`], app, { ...env, PATH: shell.path }, logDir));
			if (nodeTests.length) steps.push(runStep("node-integrations", process.execPath,
				[join(app, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.int.config.mjs", "--no-file-parallelism", ...nodeTests.map(file => `tests/${file}`)], app, env, logDir));
			const debugLogs = readdirSync(logDir).filter(name => name.endsWith("-debug.log"));
			steps.push(runStep("deadlock-logs", process.execPath, ["tests/lib/check-deadlock-logs.mjs", logDir], app, env, logDir));
			return {
				fixtureMode: "tests-copied; actual-src-and-node_modules-symlinked; no-env-test",
				debugLogCount: debugLogs.length,
				debugLogBytes: debugLogs.reduce((total, name) => total + statSync(join(logDir, name)).size, 0),
			};
		});
	} catch (error) {
		failure = error instanceof VerificationError ? { code: error.code, observed: error.observed } : { code: "integration-runner-failed" };
	}

	const afterProjects = ccProjectDirs();
	const after = { sourceRevision: sourceRevision(APP_DIR), piSettings: modification(piSettings) };
	const isPass = !failure && steps.length === shellTests.length + (nodeTests.length ? 1 : 0) + 1 && steps.every(step => step.exitCode === 0)
		&& (integration.debugLogCount as number) > 0
		&& after.sourceRevision.contentHash === before.sourceRevision.contentHash && after.piSettings === before.piSettings;
	const report = {
		schemaVersion: 1,
		sourceRevision: before.sourceRevision,
		sourceRevisionAfter: after.sourceRevision,
		versions: { ...versions(APP_DIR), piCli },
		model: `claude-bridge/${MODEL_ID}`,
		selection: values.cache ? "cache" : "approved",
		approved: { shell: shellTests, node: nodeTests },
		excluded: values.cache ? {} : { ...EXCLUDED_TESTS, "int-cache.sh": "optional-cache-test (--cache)" },
		logDir,
		integration: { ...integration, timeoutCommand, steps },
		failure,
		userPiSettingsUnchanged: after.piSettings === before.piSettings,
		newCcProjectDirs: afterProjects.filter(name => !before.ccProjects.includes(name)),
		apiCalls: "not-instrumented",
		status: isPass ? "pass" : "fail",
	};
	if (!isReportSafe(report)) throw new Error("unsafe-report-data");
	mkdirSync(dirname(reportPath), { recursive: true });
	writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
	console.log(`${report.status}\tintegration\t${steps.map(step => `${step.label}=${step.exitCode}`).join(" ")}\tdebugLogs=${integration.debugLogCount ?? 0}${failure ? `\t${failure.code}` : ""}`);
	return isPass ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
