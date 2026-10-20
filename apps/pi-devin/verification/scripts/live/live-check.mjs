#!/usr/bin/env node
// Runner for the 07 live check. Prepares the immutable 06 archive in a temporary state and runs only the cases of the
// approved plan with the pinned Pi 1.3.0 bin. Every Pi process goes through sandbox-exec (refuses real HOME reads and
// writes outside the state) and the live-guard preload (enforces hosts, UIDs, the overall cap and the free tier).
// API key environment variables never reach the child environment. Not shipped.
//
// usage:
//   node verification/scripts/live/live-check.mjs dry-run --archive <tgz> --report <path>
//   node verification/scripts/live/live-check.mjs prepare --archive <tgz> --state <dir>
//   node verification/scripts/live/live-check.mjs login --state <dir>        # run by the user (TUI /login)
//   node verification/scripts/live/live-check.mjs plan --state <dir>         # prints the plan to approve and its hash
//   node verification/scripts/live/live-check.mjs run --state <dir> --authorization <json> --report <path>
//   node verification/scripts/live/live-check.mjs cleanup --state <dir>
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptDir, "../../..");
const repoRoot = resolve(sourceRoot, "../..");
const guardPath = join(scriptDir, "live-guard.mjs");
const addToolPath = join(sourceRoot, "verification/scripts/host-contract/add-tool.mjs");
const handoff06 = JSON.parse(readFileSync(join(sourceRoot, "verification/followup/handoffs/06-artifact-r3.json"), "utf8"));
const piRoot = realpathSync(join(sourceRoot, "node_modules/@earendil-works/pi-coding-agent"));
const piPackage = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
const piBin = join(piRoot, piPackage.bin.pi);
const nodePath = realpathSync(process.execPath);
const nodePrefix = dirname(dirname(nodePath));
const realHome = realpathSync(homedir());
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const SWE2 = "swe-2";
const SWE2_FUSION = "fusion";
const LIVE_HOSTS = ["server.codeium.com", "api.devin.ai"];
/** The plan to approve. Changing it changes the plan hash and invalidates earlier approvals. */
const PLAN = {
  schemaVersion: 1,
  artifactSha256: handoff06.artifact.sha256,
  runtimeDigest: handoff06.artifact.runtimeDigest.sha256,
  allowedUIDs: ["swe-2-medium", "swe-2-high"],
  maxModelCalls: 9,
  requireFreeTier: true,
  hosts: LIVE_HOSTS,
  cases: [
    { id: "catalog", mode: "rpc", expectModelCalls: 0, purpose: "OAuth account status and catalog lookup; check that the approved UIDs are active and free tier" },
    { id: "devin-settings", mode: "rpc-devin", model: SWE2, level: "medium", prompt: "Please say hello briefly.", expectUIDs: ["swe-2-medium"], expectModelCalls: 1,
      purpose: "Real list change when the /devin recommended filter is turned on and off; real quota and session usage in the bare /devin notification after one turn" },
    { id: "plain-medium", mode: "json", model: SWE2, level: "medium", prompt: "Please say hello briefly.", expectUIDs: ["swe-2-medium"], expectModelCalls: 1 },
    { id: "level-high", mode: "json", model: SWE2, level: "high", prompt: "Please say hello briefly.", expectUIDs: ["swe-2-high"], expectModelCalls: 1 },
    { id: "add-tool", mode: "json", model: SWE2, level: "medium", prompt: "Add 2 and 3 with the add tool, then reply with only the resulting number.",
      expectUIDs: ["swe-2-medium"], expectTool: "add", expectModelCalls: 2 },
    { id: "fusion", mode: "json", model: SWE2_FUSION, level: "medium",
      prompt: "Ask the sidekick tool to 'add 2 and 3 with the add tool and report the result', then reply with only the reported number.",
      expectUIDs: ["swe-2-medium"], expectTool: "devin_sidekick", expectModelCalls: 4 },
  ],
};
const planHash = (plan) => sha256(JSON.stringify(plan));

// ---------------------------------------------------------------------------------------------
// State preparation

function runChecked(command, args, options, label) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}): ${(result.stderr || result.stdout || "").slice(-400)}`);
  return result;
}
function npmEnv(state) {
  return { PATH: [dirname(nodePath), "/usr/bin", "/bin"].join(delimiter), HOME: join(state, "home"), TMPDIR: join(state, "tmp"),
    NPM_CONFIG_USERCONFIG: join(state, "user.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(state, "global.npmrc"),
    NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_UPDATE_NOTIFIER: "false" };
}
function runtimeDigest(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const files = ["package.json"];
  const walk = (path) => {
    if (statSync(join(root, path)).isDirectory()) for (const name of readdirSync(join(root, path))) walk(join(path, name));
    else files.push(path);
  };
  for (const entry of manifest.files ?? []) if (existsSync(join(root, entry))) walk(entry);
  const lines = [...new Set(files)].sort().map((path) => `${path}\0${sha256(readFileSync(join(root, path)))}\n`);
  return { files: lines.length, sha256: sha256(lines.join("")) };
}
async function prepareState(state, archive) {
  const archiveSha = sha256(readFileSync(archive));
  if (archiveSha !== PLAN.artifactSha256) throw new Error(`archive sha256 ${archiveSha} does not match 06 artifact ${PLAN.artifactSha256}`);
  for (const directory of ["home", "tmp", "agent", "work", "artifact", "consumer"]) await mkdir(join(state, directory), { recursive: true });
  await writeFile(join(state, "user.npmrc"), "");
  await writeFile(join(state, "global.npmrc"), "");
  await writeFile(join(state, "agent", "settings.json"), JSON.stringify({ enableInstallTelemetry: false }, null, 2));
  runChecked("/usr/bin/tar", ["-xzf", archive, "-C", join(state, "artifact")], {}, "extract archive");
  const packageDir = join(state, "artifact", "package");
  await writeFile(join(state, "consumer", "package.json"), '{"name":"pi-devin-live-consumer","version":"0.0.0","private":true}\n');
  runChecked("npm", ["install", "--prefix", join(state, "consumer"), "--omit=dev", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund",
    "--cache", join(state, "tmp", "npm-cache"), archive], { env: npmEnv(state) }, "production install");
  runChecked(nodePath, [join(sourceRoot, "verification/scripts/prepare-artifact.mjs"), join(state, "consumer"), packageDir], { env: npmEnv(state) }, "prepare artifact");
  const digest = runtimeDigest(packageDir);
  if (digest.sha256 !== PLAN.runtimeDigest) throw new Error(`runtime digest ${digest.sha256} does not match 06 ${PLAN.runtimeDigest}`);
  await writeFile(join(state, "prepared.json"), JSON.stringify({ archiveSha256: archiveSha, runtimeDigest: digest, packageDir: "artifact/package" }, null, 2) + "\n");
  return { archiveSha256: archiveSha, runtimeDigest: digest };
}

// ---------------------------------------------------------------------------------------------
// Pi execution

function sandboxProfile(state, { loopbackPort } = {}) {
  const quote = (path) => JSON.stringify(path);
  return [
    "(version 1)",
    "(allow default)",
    ...(loopbackPort ? ["(deny network-outbound)", `(allow network-outbound (remote ip "localhost:${loopbackPort}"))`] : []),
    `(deny file-read-data (subpath ${quote(realHome)}))`,
    `(allow file-read-data (subpath ${quote(repoRoot)}) (subpath ${quote(piRoot)}) (subpath ${quote(nodePrefix)}) (subpath ${quote(state)}))`,
    `(deny file-read-data (subpath ${quote(join(repoRoot, "experiments"))}) (subpath ${quote(join(sourceRoot, "src"))}) (literal ${quote(join(sourceRoot, "index.ts"))}) (literal ${quote(join(sourceRoot, "cli.ts"))}))`,
    `(deny file-write* (subpath "/"))`,
    `(allow file-write* (subpath ${quote(state)}) (subpath "/dev") (subpath "/private/var/folders"))`,
  ].join("\n") + "\n";
}
/** Does not inherit the parent environment, including API key environment variables. */
function childEnv(state, guard, extra = {}) {
  return {
    PATH: [dirname(nodePath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    HOME: join(state, "home"), TMPDIR: join(state, "tmp"), PI_CODING_AGENT_DIR: join(state, "agent"),
    PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TERM: process.env.TERM ?? "xterm-256color",
    PI_DEVIN_LIVE_LEDGER: join(state, "ledger.jsonl"), PI_DEVIN_LIVE_CODEC: join(state, "artifact/package/src/core/protocol/protobuf.ts"),
    PI_DEVIN_LIVE_ALLOWED_UIDS: guard.allowedUIDs.join(","), PI_DEVIN_LIVE_ALLOWED_HOSTS: guard.hosts.join(","),
    PI_DEVIN_LIVE_MAX_MODEL_CALLS: String(guard.maxModelCalls), PI_DEVIN_LIVE_REQUIRE_FREE_TIER: guard.requireFreeTier ? "1" : "0",
    ...extra,
  };
}
function piArgv(state, args) {
  return ["/usr/bin/sandbox-exec", "-f", join(state, "sandbox.sb"), nodePath, "--import", pathToFileURL(guardPath).href, piBin,
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-extensions", "--no-mcp", "--no-builtin-tools",
    "-e", join(state, "artifact/package"), "-e", addToolPath, ...args];
}
function spawnPi(state, guard, args, extraEnv) {
  const [command, ...rest] = piArgv(state, args);
  const child = spawn(command, rest, { cwd: join(state, "work"), env: childEnv(state, guard, extraEnv), stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise((done) => child.on("close", (code, signal) => done({ code, signal, atMs: Date.now() })));
  return { child, exited };
}
function parseJsonl(text) {
  const records = [], invalid = [];
  for (let line of text.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { invalid.push(line.length); }
  }
  return { records, invalid };
}
function readLedger(state) {
  const path = join(state, "ledger.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}
function ledgerSummary(entries) {
  const count = (kind) => entries.filter((entry) => entry.kind === kind);
  const byMethod = (items) => Object.fromEntries([...items.reduce((map, entry) => map.set(entry.method, (map.get(entry.method) ?? 0) + 1), new Map())]);
  return {
    modelCalls: count("model").map((entry) => entry.uid),
    modelStatuses: count("model-response").map((entry) => entry.status),
    readCalls: byMethod(count("read")),
    readStatuses: count("read-response").map((entry) => `${entry.method}:${entry.status}`),
    blocked: count("blocked").map(({ reason, uid, host, method }) => ({ reason, uid, host, method })),
    catalog: count("catalog").at(-1)?.uids ?? null,
    halted: count("halt").map(({ reason, uids }) => ({ reason, uids })),
  };
}

async function runCase(state, guard, testCase, timeoutMs) {
  const before = readLedger(state).length, startedAt = Date.now();
  let stdout = "", stderr = "", outcome;
  if (testCase.mode === "rpc") {
    const { child, exited } = spawnPi(state, guard, ["--mode", "rpc", "--no-session"]);
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk) => { stdout += decoder.write(chunk); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let devinModels = 0;
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 1; Date.now() < deadline && devinModels === 0; attempt++) {
      child.stdin.write(JSON.stringify({ id: `models-${attempt}`, type: "get_available_models" }) + "\n");
      await sleep(1_000);
      const response = parseJsonl(stdout).records.filter((record) => record.type === "response" && record.command === "get_available_models").at(-1);
      devinModels = (response?.data?.models ?? []).filter((model) => model.provider === "devin").length;
    }
    child.stdin.end();
    const exit = await Promise.race([exited, sleep(20_000).then(() => undefined)]);
    if (!exit) child.kill("SIGKILL");
    outcome = { exitCode: exit?.code ?? null, devinModels };
  } else if (testCase.mode === "rpc-devin") {
    const { child, exited } = spawnPi(state, guard, ["--mode", "rpc", "--no-session"]);
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk) => { stdout += decoder.write(chunk); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const deadline = Date.now() + timeoutMs;
    let nextId = 0;
    const records = () => parseJsonl(stdout).records;
    const send = (command) => { const id = `devin-${++nextId}`; child.stdin.write(JSON.stringify({ id, ...command }) + "\n"); return id; };
    const waitFor = async (predicate, waitMs) => {
      const until = Math.min(deadline, Date.now() + waitMs);
      for (;;) { const value = predicate(records()); if (value || Date.now() > until) return value; await sleep(100); }
    };
    const devinModels = async () => {
      const id = send({ type: "get_available_models" });
      const response = await waitFor((items) => items.find((record) => record.type === "response" && record.id === id), 15_000);
      return (response?.data?.models ?? []).filter((model) => model.provider === "devin");
    };
    const until = async (read, isDone) => { let value = await read(); for (let attempt = 0; attempt < 50 && !isDone(value); attempt++) { await sleep(200); value = await read(); } return value; };
    const defaults = await until(devinModels, (models) => models.length > 0 || Date.now() > deadline);
    send({ type: "prompt", message: "/devin recommended on" });
    const filtered = await until(devinModels, (models) => models.length > 0 && models.length !== defaults.length);
    send({ type: "prompt", message: "/devin recommended off" });
    const restored = await until(devinModels, (models) => models.length === defaults.length);
    send({ type: "set_model", provider: "devin", modelId: testCase.model });
    send({ type: "set_thinking_level", level: testCase.level });
    await sleep(500);
    const mark = records().length;
    send({ type: "prompt", message: testCase.prompt });
    await waitFor((items) => items.slice(mark).some((record) => record.type === "agent_settled"), timeoutMs);
    const assistants = records().slice(mark).filter((record) => record.type === "message_end" && record.message?.role === "assistant").map((record) => record.message);
    send({ type: "prompt", message: "/devin" });
    const notice = await waitFor((items) => items.find((record) => record.type === "extension_ui_request" && record.method === "notify" && record.message?.includes("Account quota")), 15_000);
    child.stdin.end();
    const exit = await Promise.race([exited, sleep(20_000).then(() => undefined)]);
    if (!exit) child.kill("SIGKILL");
    const report = (notice?.message ?? "").split("\n").filter((line) => !line.startsWith("Usage:"));
    const filteredOthers = filtered.filter((model) => model.id !== SWE2_FUSION);
    outcome = {
      exitCode: exit?.code ?? null, defaultCount: defaults.length, restoredCount: restored.length,
      filtered: { count: filtered.length, uids: filteredOthers.map((model) => model.id), hasFusion: filtered.some((model) => model.id === SWE2_FUSION),
        allRecommendedExact: filteredOthers.length > 0 && filteredOthers.every((model) => !model.id.includes(":") && model.devin?.recommended === true) },
      stopReasons: assistants.map((message) => message.stopReason), responseUIDs: assistants.map((message) => message.providerThinkingLevel ?? null),
      usage: assistants.map((message) => ({ input: message.usage?.input ?? null, output: message.usage?.output ?? null })),
      report, hasQuotaLine: report.some((line) => /Daily +▕[█░]{10}▏ \d+% left|Not a quota-billed account/.test(line)), hasSessionLine: report.some((line) => /^ +1 request ·/.test(line)),
    };
  } else {
    const { child, exited } = spawnPi(state, guard, ["--mode", "json", "--no-session", "--model", `devin/${testCase.model}`, "--thinking", testCase.level, testCase.prompt]);
    const out = new StringDecoder("utf8");
    child.stdout.on("data", (chunk) => { stdout += out.write(chunk); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const exit = await exited;
    clearTimeout(timer);
    const { records, invalid } = parseJsonl(stdout);
    const assistants = records.filter((record) => record.type === "message_end" && record.message?.role === "assistant").map((record) => record.message);
    const final = assistants.at(-1);
    outcome = {
      exitCode: exit.code, timedOut: exit.signal === "SIGKILL", invalidJsonLines: invalid.length,
      agentSettled: records.filter((record) => record.type === "agent_settled").length,
      stopReasons: assistants.map((message) => message.stopReason),
      responseUIDs: assistants.map((message) => message.providerThinkingLevel ?? null),
      usage: assistants.map((message) => ({ input: message.usage?.input ?? null, output: message.usage?.output ?? null })),
      tools: records.filter((record) => record.type === "tool_execution_end").map((record) => ({ tool: record.toolName, isError: record.isError,
        result: record.toolName === "add" ? record.result?.content?.map((block) => block.text ?? "").join("") : undefined })),
      finalTextLength: final?.content?.filter((block) => block.type === "text").map((block) => block.text).join("").length ?? 0,
      finalHasFive: /(^|\D)5(\D|$)/.test(final?.content?.filter((block) => block.type === "text").map((block) => block.text).join("") ?? ""),
      errorMessage: final?.errorMessage ? final.errorMessage.slice(0, 200) : undefined,
    };
  }
  return { id: testCase.id, durationMs: Date.now() - startedAt, ...outcome, ledger: ledgerSummary(readLedger(state).slice(before)),
    stderrLines: stderr.split("\n").filter(Boolean).length };
}
function judge(testCase, result) {
  if (testCase.mode === "rpc") return result.exitCode === 0 && result.devinModels > 0 && result.ledger.halted.length === 0 && result.ledger.modelCalls.length === 0;
  if (testCase.mode === "rpc-devin") {
    return result.exitCode === 0 && result.filtered.hasFusion && result.filtered.allRecommendedExact && result.filtered.count < result.defaultCount
      && result.restoredCount === result.defaultCount && result.stopReasons.at(-1) === "stop" && result.hasQuotaLine && result.hasSessionLine
      && result.ledger.modelCalls.length === testCase.expectModelCalls && result.ledger.modelCalls.every((uid) => testCase.expectUIDs.includes(uid))
      && result.ledger.blocked.length === 0 && result.ledger.halted.length === 0;
  }
  const uidsOK = result.ledger.modelCalls.length > 0 && result.ledger.modelCalls.every((uid) => testCase.expectUIDs.includes(uid));
  const toolOK = !testCase.expectTool || result.tools.some((tool) => tool.tool === testCase.expectTool && !tool.isError);
  return result.exitCode === 0 && result.agentSettled === 1 && result.stopReasons.at(-1) === "stop" && uidsOK && toolOK && result.ledger.blocked.length === 0;
}
async function runPlan(state, guard, cases, timeoutMs) {
  const results = [];
  for (const testCase of cases) {
    const result = await runCase(state, guard, testCase, timeoutMs);
    result.pass = judge(testCase, result);
    results.push(result);
    // On an error, abort, exhausted budget or free-tier mismatch, the remaining cases are not run.
    if (!result.pass) break;
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// dry-run: runs the same plan against the mock service and checks the negative controls.

async function dryRun(archive, reportPath) {
  const { FAKE_OAUTH_TOKEN, startMockDevin } = await import(pathToFileURL(join(sourceRoot, "verification/scripts/host-contract/mock-devin.mjs")).href);
  const catalog = JSON.parse(readFileSync(join(sourceRoot, "tests/fixtures/model-catalog.json"), "utf8"));
  const withTier = (tiers) => ({ ...catalog, clientModelConfigs: catalog.clientModelConfigs.map((config) => tiers[config.modelUid] ? { ...config, modelCostTier: tiers[config.modelUid] } : config) });
  const freeCatalog = withTier({ "swe-2-medium": "MODEL_COST_TIER_FREE", "swe-2-high": "MODEL_COST_TIER_FREE", "swe-2-max": "MODEL_COST_TIER_FREE",
    "swe-2-medium-lightning": "MODEL_COST_TIER_HIGH", "swe-2-high-lightning": "MODEL_COST_TIER_HIGH", "swe-2-max-lightning": "MODEL_COST_TIER_HIGH" });
  const paidCatalog = withTier({ "swe-2-medium": "MODEL_COST_TIER_HIGH", "swe-2-high": "MODEL_COST_TIER_FREE" });
  const base = realpathSync(await mkdtemp(join("/private/tmp", "pi-devin-live-dry-")));
  const catalogPaths = { free: join(base, "catalog-free.json"), paid: join(base, "catalog-paid.json") };
  await writeFile(catalogPaths.free, JSON.stringify(freeCatalog));
  await writeFile(catalogPaths.paid, JSON.stringify(paidCatalog));
  const report = { schemaVersion: 1, kind: "pi-devin-live-dry-run", startedAt: new Date().toISOString(), node: process.version, piVersion: piPackage.version,
    planHash: planHash(PLAN), plan: PLAN, scenarios: {} };
  const stop = { stopReason: "STOP_REASON_STOP_PATTERN" }, usage = { usage: { inputTokens: 3, outputTokens: 2 } };
  const text = (value) => ({ frames: [{ messageId: "bot", deltaText: value }, stop, usage], end: "ok" });
  let callId = 0;
  const tool = (name, args) => ({ frames: [{ messageId: "bot", deltaToolCalls: [{ id: `dry-${++callId}`, name, argumentsJson: JSON.stringify(args) }] },
    { stopReason: "STOP_REASON_FUNCTION_CALL" }, usage], end: "ok" });
  const scripts = {
    catalog: [], "devin-settings": [text("Hello!")], "plain-medium": [text("Hello!")], "level-high": [text("Hello!")],
    "add-tool": [tool("add", { a: 2, b: 3 }), text("5")],
    fusion: [tool("devin_sidekick", { message: "add 2 and 3 with the add tool and report the result" }), tool("add", { a: 2, b: 3 }), text("The result is 5."), text("5")],
  };
  const scenario = async (name, { catalogPath, guard, cases }) => {
    const mock = await startMockDevin({ sourceRoot: pathToFileURL(sourceRoot + "/"), catalogPath });
    const state = join(base, name);
    try {
      await prepareState(state, archive);
      await writeFile(join(state, "agent", "auth.json"), JSON.stringify({ devin: { type: "oauth", access: FAKE_OAUTH_TOKEN, refresh: "", expires: 0,
        devin: { version: 1, apiServerURL: mock.origin, createdAt: "2026-10-19T00:00:00.000Z", flow: "browser" } } }, null, 2), { mode: 0o600 });
      await writeFile(join(state, "sandbox.sb"), sandboxProfile(state, { loopbackPort: mock.port }));
      const effective = { ...guard, hosts: [`127.0.0.1:${mock.port}`] };
      let current = "";
      mock.setChat((_entry, index) => scripts[current][Math.min(index, scripts[current].length) - 1]);
      const results = [];
      for (const testCase of cases) {
        current = testCase.id; mock.setChat((_entry, index) => scripts[current][Math.min(index, scripts[current].length) - 1]);
        const chatsBefore = mock.requests.filter((entry) => entry.method === "GetChatMessage").length;
        const result = await runCase(state, effective, testCase, 60_000);
        result.mockChatRequests = mock.requests.filter((entry) => entry.method === "GetChatMessage").length - chatsBefore;
        result.pass = judge(testCase, result);
        results.push(result);
      }
      await sleep(300);
      const ledgerText = readFileSync(join(state, "ledger.jsonl"), "utf8");
      return { results, mockRequests: mock.requests.length, mockChats: mock.requests.filter((entry) => entry.method === "GetChatMessage").map((entry) => entry.chatModelUid),
        allOAuthToken: mock.requests.every((entry) => entry.tokenMatches), ledgerHasSecret: ledgerText.includes(FAKE_OAUTH_TOKEN) || /Basic |devin-session-token/.test(ledgerText),
        openConnections: mock.openConnections() };
    } finally { await mock.close(); }
  };
  const guard = { allowedUIDs: PLAN.allowedUIDs, maxModelCalls: PLAN.maxModelCalls, requireFreeTier: PLAN.requireFreeTier };
  const byId = Object.fromEntries(PLAN.cases.map((testCase) => [testCase.id, testCase]));
  const checks = [];
  const check = (key, pass, observed) => checks.push({ key, pass: Boolean(pass), observed });

  const happy = await scenario("plan", { catalogPath: catalogPaths.free, guard, cases: PLAN.cases });
  report.scenarios.plan = happy;
  check("plan-all-cases-pass", happy.results.length === PLAN.cases.length && happy.results.every((result) => result.pass), happy.results.map((result) => [result.id, result.pass]));
  check("plan-model-calls-within-cap", happy.mockChats.length <= PLAN.maxModelCalls && happy.mockChats.every((uid) => PLAN.allowedUIDs.includes(uid)), happy.mockChats);
  check("plan-oauth-only", happy.allOAuthToken, { requests: happy.mockRequests });

  const uid = await scenario("uid-blocked", { catalogPath: catalogPaths.free, guard: { ...guard, allowedUIDs: ["swe-2-medium"] }, cases: [byId.catalog, byId["level-high"]] });
  report.scenarios.uidBlocked = uid;
  check("non-approved-uid-not-sent", uid.results[1].mockChatRequests === 0 && uid.results[1].ledger.blocked.some((entry) => entry.reason === "uid" && entry.uid === "swe-2-high"), uid.results[1].ledger.blocked);

  const sidekick = await scenario("sidekick-blocked", { catalogPath: catalogPaths.free, guard: { ...guard, allowedUIDs: ["swe-2-high"] },
    cases: [byId.catalog, { ...byId.fusion, level: "high", expectUIDs: ["swe-2-high"] }] });
  report.scenarios.sidekickBlocked = sidekick;
  check("sidekick-uid-checked-before-send", sidekick.mockChats.every((value) => value === "swe-2-high") && sidekick.results[1].ledger.blocked.some((entry) => entry.reason === "uid" && entry.uid === "swe-2-medium"),
    { sent: sidekick.mockChats, blocked: sidekick.results[1].ledger.blocked });

  const budget = await scenario("budget", { catalogPath: catalogPaths.free, guard: { ...guard, maxModelCalls: 1 }, cases: [byId.catalog, byId["add-tool"]] });
  report.scenarios.budget = budget;
  check("global-cap-enforced", budget.mockChats.length === 1 && budget.results[1].ledger.blocked.some((entry) => entry.reason === "budget"), { sent: budget.mockChats.length, blocked: budget.results[1].ledger.blocked });

  const paid = await scenario("not-free", { catalogPath: catalogPaths.paid, guard, cases: [byId.catalog, byId["plain-medium"]] });
  report.scenarios.notFree = paid;
  check("not-free-halts-before-inference", paid.results[0].ledger.halted.length === 1 && paid.mockChats.length === 0 && paid.results[1].ledger.blocked.some((entry) => entry.reason === "halted"),
    { halted: paid.results[0].ledger.halted, sent: paid.mockChats.length });

  const probeEnv = { ...process.env, DEVIN_API_KEY: "dry-run-key", WINDSURF_API_KEY: "dry-run-key" };
  const inherited = Object.keys(childEnv(base, { ...guard, hosts: [] })).filter((key) => key in probeEnv && /API_KEY/.test(key));
  check("api-key-env-not-inherited", inherited.length === 0, inherited);
  const all = [happy, uid, sidekick, budget, paid];
  check("no-secrets-in-ledgers", all.every((value) => !value.ledgerHasSecret), all.map((value) => value.ledgerHasSecret));
  check("mock-connections-closed", all.every((value) => value.openConnections === 0), all.map((value) => value.openConnections));
  // Direct sockets that bypass node:http, like Pi's bundled HTTP client, must also be refused before connecting when outside the allowed hosts.
  const probeLedger = join(base, "probe-ledger.jsonl");
  const probe = spawnSync(nodePath, ["--import", pathToFileURL(guardPath).href, "-e",
    "const s = require('node:net').connect(9, 'example.invalid'); s.on('error', (e) => console.log(e.code)); s.on('connect', () => console.log('connected'));"],
  { encoding: "utf8", timeout: 20_000, env: { ...childEnv(join(base, "plan"), { ...guard, hosts: ["127.0.0.1:1"] }), PI_DEVIN_LIVE_LEDGER: probeLedger } });
  const probeText = existsSync(probeLedger) ? readFileSync(probeLedger, "utf8") : "";
  check("socket-level-host-blocked", probe.stdout.trim() === "ELIVEGUARD" && probeText.includes('"via":"socket"'), { stdout: probe.stdout.trim(), status: probe.status });
  await rm(base, { recursive: true, force: true });
  check("dry-run-state-removed", !existsSync(base), {});
  report.checks = checks;
  report.outcome = checks.every((entry) => entry.pass) ? "pass" : "failed";
  report.completedAt = new Date().toISOString();
  const text2 = JSON.stringify(report, null, 2).split(base).join("<state>").split(sourceRoot).join("<source>").split(realHome).join("<home>");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, text2 + "\n");
  for (const entry of checks) console.log(`${entry.pass ? "ok  " : "FAIL"} ${entry.key}`);
  console.log(`${report.outcome} → ${relative(process.cwd(), reportPath)}`);
  return report.outcome === "pass";
}

// ---------------------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { archive: { type: "string" }, state: { type: "string" }, report: { type: "string" }, authorization: { type: "string" } } });
const need = (name) => { if (!values[name]) { console.error(`--${name} is required`); process.exit(2); } return values[name]; };
if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) { console.error("sandbox-exec unavailable: live check is blocked"); process.exit(2); }
if (piPackage.version !== "1.3.0") { console.error(`Pi ${piPackage.version} is not the pinned 1.3.0`); process.exit(2); }

if (command === "dry-run") {
  process.exitCode = (await dryRun(resolve(need("archive")), resolve(need("report")))) ? 0 : 1;
} else if (command === "prepare") {
  const state = resolve(need("state"));
  if (existsSync(state) && readdirSync(state).length) { console.error("state directory must be new or empty"); process.exit(2); }
  await mkdir(state, { recursive: true });
  const prepared = await prepareState(realpathSync(state), resolve(need("archive")));
  await writeFile(join(state, "sandbox.sb"), sandboxProfile(realpathSync(state)));
  console.log(JSON.stringify({ prepared, planHash: planHash(PLAN) }));
} else if (command === "plan") {
  console.log(JSON.stringify({ planHash: planHash(PLAN), plan: PLAN }, null, 2));
} else if (command === "login") {
  // The login session allows 0 model requests. Only the catalog lookup and free-tier check are recorded.
  const state = realpathSync(need("state"));
  const [bin, ...args] = piArgv(state, []);
  const child = spawn(bin, args, { cwd: join(state, "work"), env: childEnv(state, { allowedUIDs: PLAN.allowedUIDs, hosts: PLAN.hosts, maxModelCalls: 0, requireFreeTier: true }), stdio: "inherit" });
  const code = await new Promise((done) => child.on("close", done));
  const auth = existsSync(join(state, "agent", "auth.json")) ? JSON.parse(readFileSync(join(state, "agent", "auth.json"), "utf8")) : {};
  console.log(JSON.stringify({ exitCode: code, devinOAuth: auth.devin?.type === "oauth", ledger: ledgerSummary(readLedger(state)) }));
} else if (command === "run") {
  const state = realpathSync(need("state"));
  const authorization = JSON.parse(await readFile(need("authorization"), "utf8"));
  const expected = planHash(PLAN);
  if (authorization.planHash !== expected || authorization.approved !== true) { console.error(`authorization does not approve plan ${expected}`); process.exit(2); }
  const prepared = JSON.parse(await readFile(join(state, "prepared.json"), "utf8"));
  if (prepared.archiveSha256 !== PLAN.artifactSha256 || prepared.runtimeDigest.sha256 !== PLAN.runtimeDigest) { console.error("prepared artifact does not match the plan"); process.exit(2); }
  const auth = JSON.parse(await readFile(join(state, "agent", "auth.json"), "utf8"));
  if (auth.devin?.type !== "oauth") { console.error("no new Devin OAuth credential in the live state; run login first"); process.exit(2); }
  const results = await runPlan(state, { allowedUIDs: PLAN.allowedUIDs, hosts: PLAN.hosts, maxModelCalls: PLAN.maxModelCalls, requireFreeTier: PLAN.requireFreeTier }, PLAN.cases, 300_000);
  const total = ledgerSummary(readLedger(state));
  const report = { schemaVersion: 1, kind: "pi-devin-live-run", completedAt: new Date().toISOString(), node: process.version, piVersion: piPackage.version,
    planHash: expected, authorization: { approvedAt: authorization.approvedAt, scope: authorization.scope }, prepared, results,
    notRun: PLAN.cases.slice(results.length).map((testCase) => testCase.id), totals: total,
    outcome: results.length === PLAN.cases.length && results.every((result) => result.pass) ? "pass" : "failed" };
  const text = JSON.stringify(report, null, 2).split(state).join("<state>").split(sourceRoot).join("<source>").split(realHome).join("<home>");
  await writeFile(resolve(need("report")), text + "\n");
  console.log(`${report.outcome}: ${results.map((result) => `${result.id}=${result.pass ? "pass" : "fail"}`).join(" ")}; model calls ${total.modelCalls.length}`);
  process.exitCode = report.outcome === "pass" ? 0 : 1;
} else if (command === "cleanup") {
  const state = realpathSync(need("state"));
  if (!existsSync(join(state, "prepared.json"))) { console.error("refusing to remove a directory that live-check did not prepare"); process.exit(2); }
  await rm(state, { recursive: true, force: true });
  console.log(JSON.stringify({ removed: !existsSync(state) }));
} else {
  console.error("usage: live-check.mjs dry-run|prepare|plan|login|run|cleanup ...");
  process.exitCode = 2;
}
