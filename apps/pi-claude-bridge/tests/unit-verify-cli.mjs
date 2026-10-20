import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APP_DIR, parseCLI, runCLI } from "../tools/verify/cli.js";
import { discoverChecks } from "../tools/verify/discovery.js";
import { assertLiveEnvironment, assertSubscriptionAccount } from "../tools/verify/policy.js";
import { isReportSafe, sourceRevision } from "../tools/verify/report.js";
import { withWorkspace } from "../tools/verify/workspace.js";
import { withCapturedQueries } from "../tools/verify/capture.js";
import { fixtureUser } from "../tools/verify/harness.js";
import { VerificationError } from "../tools/verify/types.js";

async function fixtures(run) {
	const directory = mkdtempSync(join(tmpdir(), "bridge-cli-unit-"));
	const add = (name, mode, body = "return { completed: true };") => writeFileSync(join(directory, `${name}.ts`),
		`export default { name: ${JSON.stringify(name)}, mode: ${JSON.stringify(mode)}, inputs: {}, expected: {}, async run(context) { ${body} } };\n`);
	try { await run({ directory, add }); }
	finally { rmSync(directory, { recursive: true, force: true }); }
}

test("verification argument parsing rejects ambiguous or unknown arguments", () => {
	assert.equal(parseCLI(["--all"]).all, true);
	assert.deepEqual(parseCLI(["provider-options", "provider-options"]).names, ["provider-options"]);
	for (const args of [[], ["--unknown"], ["--all", "provider-options"], ["--list", "--all"]]) assert.throws(() => parseCLI(args));
});

test("verification discovers a new check without registry changes", async () => {
	await fixtures(async ({ directory, add }) => {
		add("first-check", "offline");
		assert.deepEqual((await discoverChecks(directory)).map(check => check.name), ["first-check"]);
		add("second-check", "spawn");
		assert.deepEqual((await discoverChecks(directory)).map(check => check.name), ["first-check", "second-check"]);
		const lines = [];
		assert.equal(await runCLI(["--list"], { checksDir: directory, print: line => lines.push(line) }), 0);
		assert.deepEqual(lines, ["first-check\toffline", "second-check\tspawn"]);
	});
});

test("unknown verification check exits 2 without running a check", async () => {
	await fixtures(async ({ directory, add }) => {
		add("known", "offline", "throw new Error('must not run');");
		const report = join(directory, "report.json");
		assert.equal(await runCLI(["missing", "--report", report], { checksDir: directory, print() {} }), 2);
		const value = JSON.parse(readFileSync(report, "utf8"));
		assert.equal(value.apiCalls, 0);
		assert.deepEqual(value.checks, []);
		assert.equal(value.errorCode, "unknown-check");
	});
});

test("all-skipped and mixed runs keep skipped separate from pass and exit 0", async () => {
	await fixtures(async ({ directory, add }) => {
		add("live-fixture", "live", "throw new Error('must not run without --live');");
		add("offline-fixture", "offline");
		for (const args of [["live-fixture"], ["--all"]]) {
			const report = join(directory, "report.json");
			const lines = [];
			assert.equal(await runCLI([...args, "--report", report], { checksDir: directory, print: line => lines.push(line) }), 0);
			const value = JSON.parse(readFileSync(report, "utf8"));
			assert.equal(value.checks.find(check => check.name === "live-fixture").status, "skipped");
			assert.equal(value.checks.filter(check => check.status === "pass").length, args[0] === "--all" ? 1 : 0);
			assert.equal(value.apiCalls, 0);
			assert.match(lines.at(-1), /skipped 1/);
		}
	});
});

test("failed checks exit 1 and raw failure details do not enter reports", async () => {
	await fixtures(async ({ directory, add }) => {
		add("failing", "offline", "throw new Error('private request details');");
		const report = join(directory, "report.json");
		assert.equal(await runCLI(["--all", "--report", report], { checksDir: directory, print() {} }), 1);
		const text = readFileSync(report, "utf8");
		assert.equal(JSON.parse(text).checks[0].status, "fail");
		assert(!text.includes("private request details"));
	});
});

test("live authentication and model guards stop before check invocation", async () => {
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_UNKNOWN"]) {
		for (const value of ["", "0", "dummy"]) assert.throws(() => assertLiveEnvironment({ [key]: value }, "claude-haiku-5-5"));
	}
	await fixtures(async ({ directory, add }) => {
		add("live-fixture", "live", "throw new Error('must not run');");
		for (const [args, env] of [
			[["live-fixture", "--live"], { ANTHROPIC_API_KEY: "dummy" }],
			[["live-fixture", "--live", "--model", "claude-haiku-4-5"], {}],
		]) {
			const report = join(directory, "report.json");
			assert.equal(await runCLI([...args, "--report", report], { checksDir: directory, env, print() {} }), 2);
			const value = JSON.parse(readFileSync(report, "utf8"));
			assert.equal(value.apiCalls, 0);
			assert.deepEqual(value.checks, []);
		}
	});
});

test("account preflight accepts the optional OAuth source but rejects API keys and other backends", () => {
	assert.doesNotThrow(() => assertSubscriptionAccount({ apiProvider: "firstParty" }));
	assert.doesNotThrow(() => assertSubscriptionAccount({ apiProvider: "firstParty", apiKeySource: "none" }));
	for (const account of [{}, { apiProvider: "gateway" }, { apiProvider: "firstParty", apiKeySource: "apiKeyHelper" }, { apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }])
		assert.throws(() => assertSubscriptionAccount(account));
});

test("report safety rejects raw payloads, tokens, binary data and cycles", () => {
	const cycle = {}; cycle.self = cycle;
	for (const value of [{ prompt: "raw" }, { messages: [] }, { credential: "Bearer fixture" }, Buffer.from("private"), cycle]) assert.equal(isReportSafe(value), false);
	assert.equal(isReportSafe({ input: { sha256: "0".repeat(64), byteLength: 24 }, apiKeySource: "none" }), true);
});

test("unsafe check observations fail without leaking their contents", async () => {
	await fixtures(async ({ directory, add }) => {
		add("unsafe", "offline", "return { credential: 'Bearer fixture' };");
		const report = join(directory, "report.json");
		const lines = [];
		assert.equal(await runCLI(["--all", "--report", report], { checksDir: directory, print: line => lines.push(line) }), 1);
		const text = readFileSync(report, "utf8");
		assert(!/sk-ant|bearer|authorization/i.test(text + lines.join("\n")));
		assert.equal(JSON.parse(text).checks[0].observed.errorCode, "unsafe-report-data");
	});
});

test("failed verification restores env/cwd and removes only its temporary state", async () => {
	const env = { ...process.env };
	const cwd = process.cwd();
	let root;
	let sessionDir;
	await assert.rejects(withWorkspace(false, async workspace => {
		root = workspace.root; sessionDir = workspace.ccSessionDir;
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "fixture.jsonl"), "fixture");
		process.env.BRIDGE_VERIFY_TEMP = "fixture";
		throw new VerificationError("fixture-failure");
	}), error => {
		assert.equal(error.code, "fixture-failure");
		assert.deepEqual(error.observed.cleanup, { temporaryCwdRemoved: true, ccSessionDirectoryRemoved: true, userSettingsUnchanged: true });
		return true;
	});
	assert.equal(process.cwd(), cwd);
	assert.deepEqual({ ...process.env }, env);
	assert(!existsSync(root) && !existsSync(sessionDir));
});

test("verification harness preserves an explicitly selected Pi session", async () => {
	await withCapturedQueries({ appDir: APP_DIR, modelId: "claude-haiku-5-5", isLive: false, apiCalls: 0 }, async (harness, captures, workspace) => {
		const selected = randomUUID();
		await harness.turn({ messages: [fixtureUser("selected session fixture")], tools: [] }, { sessionId: selected });
		await harness.waitForIdle();
		assert(harness.runtime.sessionStateFor(selected));
		assert.equal(harness.runtime.sessionStateFor(workspace.sessionId), null);
		return {};
	});
});

test("source revision includes untracked package content, not only HEAD", () => {
	const marker = join(APP_DIR, `verify-revision-${randomUUID()}.txt`);
	const before = sourceRevision(APP_DIR);
	try {
		writeFileSync(marker, "first");
		const first = sourceRevision(APP_DIR);
		assert.notEqual(first.contentHash, before.contentHash);
		writeFileSync(marker, "second");
		assert.notEqual(sourceRevision(APP_DIR).contentHash, first.contentHash);
	} finally { rmSync(marker, { force: true }); }
	assert.equal(sourceRevision(APP_DIR).contentHash, before.contentHash);
});
