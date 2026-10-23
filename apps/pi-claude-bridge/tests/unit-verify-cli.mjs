import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { APP_DIR, parseCLI, runCLI } from "../tools/verify/cli.js";
import { discoverChecks } from "../tools/verify/discovery.js";
import { assertLiveEnvironment, assertSubscriptionAccount } from "../tools/verify/policy.js";
import { isReportSafe, sourceRevision } from "../tools/verify/report.js";
import { withWorkspace } from "../tools/verify/workspace.js";
import { withCapturedQueries } from "../tools/verify/capture.js";
import { createHarness, fixtureUser } from "../tools/verify/harness.js";
import { VerificationError } from "../tools/verify/types.js";

async function fixtures(run) {
	const directory = mkdtempSync(join(tmpdir(), "bridge-cli-unit-"));
	const add = (name, mode, body = "return { completed: true };") => writeFileSync(join(directory, `${name}.ts`),
		`export default { name: ${JSON.stringify(name)}, mode: ${JSON.stringify(mode)}, inputs: {}, expected: {}, async run(context) { ${body} } };\n`);
	try { await run({ directory, add }); }
	finally { rmSync(directory, { recursive: true, force: true }); }
}

test("verification argument parsing rejects ambiguous or unknown arguments", () => {
	expect(parseCLI(["--all"]).all).toBe(true);
	expect(parseCLI(["provider-options", "provider-options"]).names).toStrictEqual(["provider-options"]);
	for (const args of [[], ["--unknown"], ["--all", "provider-options"], ["--list", "--all"]]) expect(() => parseCLI(args)).toThrow();
});

test("verification discovers a new check without registry changes", async () => {
	await fixtures(async ({ directory, add }) => {
		add("first-check", "offline");
		expect((await discoverChecks(directory)).map(check => check.name)).toStrictEqual(["first-check"]);
		add("second-check", "spawn");
		expect((await discoverChecks(directory)).map(check => check.name)).toStrictEqual(["first-check", "second-check"]);
		const lines = [];
		expect(await runCLI(["--list"], { checksDir: directory, print: line => lines.push(line) })).toBe(0);
		expect(lines).toStrictEqual(["first-check\toffline", "second-check\tspawn"]);
	});
});

test("unknown verification check exits 2 without running a check", async () => {
	await fixtures(async ({ directory, add }) => {
		add("known", "offline", "throw new Error('must not run');");
		const report = join(directory, "report.json");
		expect(await runCLI(["missing", "--report", report], { checksDir: directory, print() {} })).toBe(2);
		const value = JSON.parse(readFileSync(report, "utf8"));
		expect(value.apiCalls).toBe(0);
		expect(value.checks).toStrictEqual([]);
		expect(value.errorCode).toBe("unknown-check");
	});
});

test("all-skipped and mixed runs keep skipped separate from pass and exit 0", async () => {
	await fixtures(async ({ directory, add }) => {
		add("live-fixture", "live", "throw new Error('must not run without --live');");
		add("offline-fixture", "offline");
		for (const args of [["live-fixture"], ["--all"]]) {
			const report = join(directory, "report.json");
			const lines = [];
			expect(await runCLI([...args, "--report", report], { checksDir: directory, print: line => lines.push(line) })).toBe(0);
			const value = JSON.parse(readFileSync(report, "utf8"));
			expect(value.checks.find(check => check.name === "live-fixture").status).toBe("skipped");
			expect(value.checks.filter(check => check.status === "pass").length).toBe(args[0] === "--all" ? 1 : 0);
			expect(value.apiCalls).toBe(0);
			expect(lines.at(-1)).toMatch(/skipped 1/);
		}
	});
});

test("failed checks exit 1 and raw failure details do not enter reports", async () => {
	await fixtures(async ({ directory, add }) => {
		add("failing", "offline", "throw new Error('private request details');");
		const report = join(directory, "report.json");
		expect(await runCLI(["--all", "--report", report], { checksDir: directory, print() {} })).toBe(1);
		const text = readFileSync(report, "utf8");
		expect(JSON.parse(text).checks[0].status).toBe("fail");
		expect(text.includes("private request details")).toBeFalsy();
	});
});

test("live authentication and model guards stop before check invocation", async () => {
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_UNKNOWN"]) {
		for (const value of ["", "0", "dummy"]) expect(() => assertLiveEnvironment({ [key]: value }, "claude-haiku-5-5")).toThrow();
	}
	await fixtures(async ({ directory, add }) => {
		add("live-fixture", "live", "throw new Error('must not run');");
		for (const [args, env] of [
			[["live-fixture", "--live"], { ANTHROPIC_API_KEY: "dummy" }],
			[["live-fixture", "--live", "--model", "claude-haiku-4-5"], {}],
		]) {
			const report = join(directory, "report.json");
			expect(await runCLI([...args, "--report", report], { checksDir: directory, env, print() {} })).toBe(2);
			const value = JSON.parse(readFileSync(report, "utf8"));
			expect(value.apiCalls).toBe(0);
			expect(value.checks).toStrictEqual([]);
		}
	});
});

test("account preflight accepts the optional OAuth source but rejects API keys and other backends", () => {
	expect(() => assertSubscriptionAccount({ apiProvider: "firstParty" })).not.toThrow();
	expect(() => assertSubscriptionAccount({ apiProvider: "firstParty", apiKeySource: "none" })).not.toThrow();
	for (const account of [{}, { apiProvider: "gateway" }, { apiProvider: "firstParty", apiKeySource: "apiKeyHelper" }, { apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }])
		expect(() => assertSubscriptionAccount(account)).toThrow();
});

test("report safety rejects raw payloads, tokens, binary data and cycles", () => {
	const cycle = {}; cycle.self = cycle;
	for (const value of [{ prompt: "raw" }, { messages: [] }, { credential: "Bearer fixture" }, Buffer.from("private"), cycle]) expect(isReportSafe(value)).toBe(false);
	expect(isReportSafe({ input: { sha256: "0".repeat(64), byteLength: 24 }, apiKeySource: "none" })).toBe(true);
});

test("unsafe check observations fail without leaking their contents", async () => {
	await fixtures(async ({ directory, add }) => {
		add("unsafe", "offline", "return { credential: 'Bearer fixture' };");
		const report = join(directory, "report.json");
		const lines = [];
		expect(await runCLI(["--all", "--report", report], { checksDir: directory, print: line => lines.push(line) })).toBe(1);
		const text = readFileSync(report, "utf8");
		expect(/sk-ant|bearer|authorization/i.test(text + lines.join("\n"))).toBeFalsy();
		expect(JSON.parse(text).checks[0].observed.errorCode).toBe("unsafe-report-data");
	});
});

test("failed verification restores env/cwd and removes only its temporary state", async () => {
	const env = { ...process.env };
	const cwd = process.cwd();
	let root;
	let sessionDir;
	await expect(withWorkspace(false, async workspace => {
		root = workspace.root; sessionDir = workspace.ccSessionDir;
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "fixture.jsonl"), "fixture");
		process.env.BRIDGE_VERIFY_TEMP = "fixture";
		throw new VerificationError("fixture-failure");
	})).rejects.toThrow(expect.toSatisfy(error => {
		expect(error.code).toBe("fixture-failure");
		expect(error.observed.cleanup).toStrictEqual({ temporaryCwdRemoved: true, ccSessionDirectoryRemoved: true, userSettingsUnchanged: true });
		return true;
	}));
	expect(process.cwd()).toBe(cwd);
	expect({ ...process.env }).toStrictEqual(env);
	expect(!existsSync(root) && !existsSync(sessionDir)).toBeTruthy();
});

test("verification harness preserves an explicitly selected Pi session", async () => {
	await withCapturedQueries({ appDir: APP_DIR, modelId: "claude-haiku-5-5", isLive: false, apiCalls: 0 }, async (harness, captures, workspace) => {
		const selected = randomUUID();
		await harness.turn({ messages: [fixtureUser("selected session fixture")], tools: [] }, { sessionId: selected });
		await harness.waitForIdle();
		expect(harness.runtime.sessionStateFor(selected)).toBeTruthy();
		expect(harness.runtime.sessionStateFor(workspace.sessionId)).toBe(null);
		return {};
	});
});

test("closing a verification runtime withdraws only its own hooks", async () => {
	await withWorkspace(false, async workspace => {
		const first = createHarness(workspace), sibling = createHarness(workspace);
		const rebuild = globalThis[Symbol.for("claude-bridge:markRebuildHooks")];
		const release = globalThis[Symbol.for("claude-bridge:releaseSessionQueriesHooks")];
		try {
			await first.close();
			expect(rebuild.has(first.runtime.markRebuildForSession)).toBe(false);
			expect(release.has(first.runtime.releaseSessionQueryContext)).toBe(false);
			expect(rebuild.has(sibling.runtime.markRebuildForSession)).toBe(true);
			expect(release.has(sibling.runtime.releaseSessionQueryContext)).toBe(true);
		} finally { await sibling.close(); }
		return {};
	});
});

test("source revision includes untracked package content, not only HEAD", () => {
	const marker = join(APP_DIR, `verify-revision-${randomUUID()}.txt`);
	const before = sourceRevision(APP_DIR);
	try {
		writeFileSync(marker, "first");
		const first = sourceRevision(APP_DIR);
		expect(first.contentHash).not.toBe(before.contentHash);
		writeFileSync(marker, "second");
		expect(sourceRevision(APP_DIR).contentHash).not.toBe(first.contentHash);
	} finally { rmSync(marker, { force: true }); }
	expect(sourceRevision(APP_DIR).contentHash).toBe(before.contentHash);
});
