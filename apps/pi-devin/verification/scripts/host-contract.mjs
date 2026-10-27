#!/usr/bin/env node
// Verifies the provider contract by connecting the pinned Pi 1.3.0 bin's TUI, print, JSON and RPC paths to a loopback mock Devin service.
// Each scenario runs inside macOS sandbox-exec with a fresh temporary HOME/agent/cwd. The sandbox refuses network outside the mock
// service port, reads of the real HOME (except the repository, Node and temp paths) and writes outside the temp paths. Not shipped.
//
// usage: node verification/scripts/host-contract.mjs --report <path>
//          [--package-root <dir>] [--pi-root <dir>] [--only rpc,print,json,oauth,cache,tui,help] [--keep]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { FAKE_OAUTH_TOKEN, startMockDevin } from "./host-contract/mock-devin.mjs";

const SCENARIOS = ["help", "rpc", "print", "json", "oauth", "cache", "tui"];
const FAKE_API_KEY = "host-contract-fake-api-key";
// Public model IDs shown in Pi `/model`: groups use `familyID[-differing dimensions]`, variants the catalog UID, Fusion `fusion`.
const SWE2 = "swe-2";
const FUSION_ID = "fusion";
const REPORT_PREFIX = "Sidekick report for background handoff";
const SOL = "gpt-5.6-sol";
const UNEXPOSED_UIDS = ["kimi-k2-6", "kimi-k2-7", "swe-1-6", "swe-1-6-fast"];
const OAUTH_ONLY_TEXT = "API key authentication is not supported";
const TOOL_ROUNDS = 12;
const LONG_CACHE_TEXT = "Long cache lifetime is not confirmed";
const COMMON_ARGS = ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-extensions", "--no-mcp", "--no-builtin-tools"];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptDir, "../..");
const repoRoot = resolve(sourceRoot, "../..");
const { values } = parseArgs({ options: {
  report: { type: "string" }, "package-root": { type: "string" }, "pi-root": { type: "string" }, only: { type: "string" }, keep: { type: "boolean" },
} });
if (!values.report) {
  console.error("usage: node verification/scripts/host-contract.mjs --report <path> [--package-root <dir>] [--pi-root <dir>] [--only <names>] [--keep]");
  process.exit(2);
}
const reportPath = resolve(values.report);
const selected = values.only ? values.only.split(",").map((name) => name.trim()) : SCENARIOS;
for (const name of selected) if (!SCENARIOS.includes(name)) { console.error(`unknown scenario: ${name}`); process.exit(2); }
const packageRoot = realpathSync(values["package-root"] ?? sourceRoot);
const piRoot = realpathSync(values["pi-root"] ?? join(sourceRoot, "node_modules/@earendil-works/pi-coding-agent"));
const piPackage = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
const piBin = join(piRoot, piPackage.bin.pi);
const nodePath = realpathSync(process.execPath);
const nodePrefix = dirname(dirname(nodePath));
const realHome = realpathSync(homedir());
const isArtifactRun = packageRoot !== realpathSync(sourceRoot);
const tempBase = realpathSync(existsSync("/private/tmp") ? "/private/tmp" : tmpdir());
const guardPath = join(scriptDir, "host-contract/guard.mjs");
const addToolPath = join(scriptDir, "host-contract/add-tool.mjs");
const bridgePath = join(scriptDir, "host-contract/pty-bridge.py");
const catalogPath = join(sourceRoot, "tests/fixtures/model-catalog.json");
const roots = [];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** Combines the sorted relative paths and SHA-256 of package.json and the files entries into one digest. */
function packageRuntimeDigest(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const files = ["package.json"];
  const walk = (path) => {
    if (statSync(join(root, path)).isDirectory()) for (const name of readdirSync(join(root, path))) walk(join(path, name));
    else files.push(path);
  };
  for (const entry of manifest.files ?? []) if (existsSync(join(root, entry))) walk(entry);
  const lines = [...new Set(files)].sort().map((path) => `${path.split("\\").join("/")}\0${sha256(join(root, path))}\n`);
  return { method: "sha256 of sorted 'path\\0sha256\\n' lines over package.json and manifest files", files: lines.length,
    sha256: createHash("sha256").update(lines.join("")).digest("hex") };
}
function which(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) if (directory && existsSync(join(directory, name))) return join(directory, name);
  return undefined;
}
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms: ${label}`);
    await sleep(20);
  }
}
/** Replaces real paths and fake secrets so they never reach the report. */
function sanitize(text) {
  let value = String(text);
  for (const root of roots) value = value.split(root).join("<root>");
  for (const [path, label] of [[packageRoot, "<package>"], [piRoot, "<pi>"], [sourceRoot, "<source>"], [repoRoot, "<repo>"], [nodePrefix, "<node>"], [realHome, "<home>"]]) {
    value = value.split(path).join(label);
  }
  value = value.split(FAKE_OAUTH_TOKEN).join("<fake-oauth>").split(FAKE_API_KEY).join("<fake-api-key>");
  return value.split(basename(realHome)).join("<user>");
}
/** The TUI wraps long paths, so path fragments left after full-path replacement are masked too. */
const sanitizeScreen = (text) => sanitize(text).replace(/[\w.@+<>-]*(?:\/[\w.@+<>-]+){2,}\/?/g, "<path>");
const stripAnsi = (text) => text
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/\x1b[@-Z\\-_]/g, "")
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const excerpt = (text, length = 600) => sanitize(text.length > length ? "…" + text.slice(-length) : text);
const compactScreen = (text) => text.replace(/[ \t]+/g, " ").replace(/─{3,}/g, "──").replace(/\n[ \t]*(?=\n)/g, "").trim();
const screenExcerpt = (text, length = 700) => {
  const value = compactScreen(text);
  return sanitizeScreen(value.length > length ? "…" + value.slice(-length) : value);
};

// ---------------------------------------------------------------------------------------------
// Mock reply plans

let callCounter = 0;
const STOP = { stopReason: "STOP_REASON_STOP_PATTERN" };
const USAGE = { usage: { inputTokens: 3, outputTokens: 2 } };
const textPlan = (text, label) => ({ label, frames: [{ messageId: "bot", deltaText: text }, STOP, USAGE], end: "ok" });
function toolPlan(name, args, label, { split = false } = {}) {
  const id = `call-${label}-${++callCounter}`, json = JSON.stringify(args);
  const deltas = split
    ? [{ messageId: "bot", deltaToolCalls: [{ id, name, argumentsJson: json.slice(0, 5) }] }, { deltaToolCalls: [{ argumentsJson: json.slice(5) }] }]
    : [{ messageId: "bot", deltaToolCalls: [{ id, name, argumentsJson: json }] }];
  return { label, frames: [...deltas, { stopReason: "STOP_REASON_FUNCTION_CALL" }, USAGE], end: "ok" };
}
const failPlan = (label, frames = []) => ({ label, frames, end: { code: "invalid_argument", message: "host-contract scripted failure" } });
const hangPlan = (label) => ({ label, frames: [{ messageId: "bot", deltaText: "partial reply " }], end: "hang" });
const sequence = (...plans) => (_entry, index) => plans[Math.min(index, plans.length) - 1];

// ---------------------------------------------------------------------------------------------
// Isolated environment and Pi execution

let mock;
async function createRoot(name, credential = "oauth") {
  const root = realpathSync(await mkdtemp(join(tempBase, `pi-devin-host-${name}-`)));
  roots.push(root);
  const env = { name, root, home: join(root, "home"), agent: join(root, "agent"), work: join(root, "work"), tmp: join(root, "tmp"),
    guardLog: join(root, "guard.jsonl"), profile: join(root, "sandbox.sb") };
  for (const directory of [env.home, env.agent, env.work, env.tmp]) await mkdir(directory, { recursive: true });
  await writeFile(join(env.agent, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }, null, 2));
  await writeAuth(env, credential);
  const quote = (path) => JSON.stringify(path);
  await writeFile(env.profile, [
    "(version 1)",
    "(allow default)",
    "(deny network-outbound)",
    `(allow network-outbound (remote ip "localhost:${mock.port}"))`,
    `(deny file-read-data (subpath ${quote(realHome)}))`,
    `(allow file-read-data (subpath ${quote(repoRoot)}) (subpath ${quote(packageRoot)}) (subpath ${quote(piRoot)}) (subpath ${quote(nodePrefix)}) (subpath ${quote(root)}))`,
    `(deny file-read-data (subpath ${quote(join(repoRoot, "experiments"))}))`,
    // When checking an extracted artifact, the Pi process must not read the source runtime. The mock service (runner process) is outside the sandbox.
    ...(isArtifactRun ? [`(deny file-read-data (subpath ${quote(join(sourceRoot, "src"))}) (literal ${quote(join(sourceRoot, "index.ts"))}) (literal ${quote(join(sourceRoot, "cli.ts"))}))`] : []),
    `(deny file-write* (subpath "/"))`,
    `(allow file-write* (subpath ${quote(root)}) (subpath "/dev") (subpath "/private/var/folders"))`,
  ].join("\n") + "\n");
  return env;
}
async function writeAuth(env, credential) {
  const entries = {};
  if (credential === "oauth") entries.devin = { type: "oauth", access: FAKE_OAUTH_TOKEN, refresh: "", expires: 0,
    devin: { version: 1, apiServerURL: mock.origin, createdAt: "2026-10-19T00:00:00.000Z", flow: "browser" } };
  if (credential === "api_key") entries.devin = { type: "api_key", key: FAKE_API_KEY };
  await writeFile(join(env.agent, "auth.json"), JSON.stringify(entries, null, 2), { mode: 0o600 });
}
async function readAuth(env) { return JSON.parse(await readFile(join(env.agent, "auth.json"), "utf8")); }
function childEnv(env, extra = {}, isTui = false) {
  return {
    PATH: [dirname(nodePath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    HOME: env.home, TMPDIR: env.tmp, PI_CODING_AGENT_DIR: env.agent,
    PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TERM: isTui ? "xterm-256color" : "dumb",
    PI_DEVIN_HOST_GUARD_LOG: env.guardLog, PI_DEVIN_HOST_GUARD_PORT: String(mock.port), ...extra,
  };
}
function piArgv(env, args, isTui = false) {
  const base = ["/usr/bin/sandbox-exec", "-f", env.profile, nodePath, "--import", pathToFileURL(guardPath).href, piBin,
    ...COMMON_ARGS, "-e", packageRoot, "-e", addToolPath, ...args];
  return isTui ? [python, bridgePath, "160", "50", "--", ...base] : base;
}
const owned = new Set();
function spawnPi(env, args, { extraEnv, isTui = false } = {}) {
  const [command, ...rest] = piArgv(env, args, isTui);
  const child = spawn(command, rest, { cwd: env.work, env: childEnv(env, extraEnv, isTui), stdio: ["pipe", "pipe", "pipe"] });
  owned.add(child);
  const exited = new Promise((done) => child.on("close", (code, signal) => { owned.delete(child); done({ code, signal, atMs: Date.now() }); }));
  return { child, exited };
}
async function runPi(env, args, { extraEnv, timeoutMs = 60_000 } = {}) {
  const startedAt = Date.now(), { child, exited } = spawnPi(env, args, { extraEnv });
  const out = new StringDecoder("utf8"), err = new StringDecoder("utf8");
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += out.write(chunk); });
  child.stderr.on("data", (chunk) => { stderr += err.write(chunk); });
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const result = await exited;
  clearTimeout(timer);
  return { ...result, stdout: stdout + out.end(), stderr: stderr + err.end(), durationMs: result.atMs - startedAt, timedOut: result.signal === "SIGKILL" };
}
function parseJsonl(text) {
  const records = [], invalid = [];
  for (let line of text.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { invalid.push(line.slice(0, 200)); }
  }
  return { records, invalid };
}
function startRpc(env, { extraEnv } = {}) {
  const { child, exited } = spawnPi(env, ["--mode", "rpc"], { extraEnv });
  const records = [], invalid = [], decoder = new StringDecoder("utf8");
  let buffer = "", stderr = "", nextId = 0;
  child.stdout.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      try { records.push(JSON.parse(line)); } catch { invalid.push(line.slice(0, 200)); }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let exit;
  void exited.then((value) => { exit = value; });
  return {
    records, invalid, child, exited, stderr: () => stderr, exit: () => exit,
    mark: () => records.length,
    async request(command, timeoutMs = 15_000) {
      const id = `hc-${++nextId}`;
      child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
      return waitUntil(() => records.find((record) => record.type === "response" && record.id === id), timeoutMs, `rpc response ${command.type}`);
    },
    waitRecord(predicate, from, timeoutMs, label) {
      return waitUntil(() => records.slice(from).find(predicate), timeoutMs, label);
    },
  };
}
async function waitForDevinModels(rpc) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await rpc.request({ type: "get_available_models" });
    const models = (response.data?.models ?? []).filter((model) => model.provider === "devin");
    if (models.length) return models;
    if (Date.now() > deadline) throw new Error("devin models did not appear in RPC get_available_models");
    await sleep(200);
  }
}
/** print and JSON modes use only the stored catalog, so a real RPC background refresh fills models-store first. */
async function seedCatalog(env) {
  const rpc = startRpc(env);
  try {
    const models = await waitForDevinModels(rpc);
    rpc.child.stdin.end();
    const exit = await Promise.race([rpc.exited, sleep(15_000).then(() => undefined)]);
    if (!exit) throw new Error("seed RPC process did not exit after stdin end");
    return { devinModels: models.length, exitCode: exit.code, modelsStoreWritten: existsSync(join(env.agent, "models-store.json")) };
  } finally { if (rpc.exit() === undefined) rpc.child.kill("SIGKILL"); }
}
async function guardSummary(env) {
  const entries = existsSync(env.guardLog) ? parseJsonl(await readFile(env.guardLog, "utf8")).records : [];
  const blocked = entries.filter((entry) => entry.allowed === false);
  const count = (items, key) => Object.fromEntries([...items.reduce((map, item) => map.set(item[key], (map.get(item[key]) ?? 0) + 1), new Map())]);
  return {
    guardedProcesses: new Set(entries.filter((entry) => entry.kind === "guard").map((entry) => entry.pid)).size,
    allowedLoopbackConnections: entries.filter((entry) => entry.kind === "net" && entry.allowed).length,
    blockedNetworkHosts: count(blocked.filter((entry) => entry.kind === "net" || entry.kind === "fetch"), "host"),
    spawnedCommands: count(entries.filter((entry) => ["spawn", "spawnSync", "execFileSync", "execSync"].includes(entry.kind)), "file"),
    blockedCommands: blocked.filter((entry) => entry.file).map((entry) => entry.file),
  };
}

// ---------------------------------------------------------------------------------------------
// Result summary

function runSummary(records) {
  const assistants = records.filter((record) => record.type === "message_end" && record.message?.role === "assistant").map((record) => record.message);
  const last = assistants.at(-1);
  return {
    agentEnds: records.filter((record) => record.type === "agent_end").length,
    settled: records.filter((record) => record.type === "agent_settled").map((record) => ({ aborted: record.aborted })),
    stopReasons: assistants.map((message) => message.stopReason),
    finalText: last?.content?.filter((block) => block.type === "text").map((block) => block.text).join("") ?? "",
    errorMessage: last?.errorMessage ? sanitize(last.errorMessage) : undefined,
    toolStarts: records.filter((record) => record.type === "tool_execution_start").map((record) => record.toolName),
    toolEnds: records.filter((record) => record.type === "tool_execution_end").map((record) => ({ tool: record.toolName, isError: record.isError,
      text: sanitize(record.result?.content?.map((block) => block.text ?? "").join("") ?? "") })),
    toolcallDeltas: records.filter((record) => record.type === "message_update" && record.assistantMessageEvent?.type === "toolcall_delta").length,
    textDeltas: records.filter((record) => record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta").length,
  };
}
const requestsSince = (from) => mock.requests.slice(from);
const chatsSince = (from) => requestsSince(from).filter((entry) => entry.method === "GetChatMessage");
function requestView(entry) {
  const { atMs: _atMs, seq: _seq, toolResults, lastUserText, ...rest } = entry;
  return { ...rest, ...(toolResults ? { toolResults: toolResults.map(sanitize) } : {}), ...(lastUserText ? { lastUserText: sanitize(lastUserText) } : {}),
    ...(rest.lastPrompt ? { lastPrompt: { source: rest.lastPrompt.source, text: sanitize(rest.lastPrompt.text).slice(0, 160) } } : {}) };
}

class Scenario {
  constructor(name) { this.name = name; this.checks = []; this.steps = {}; this.startedAt = Date.now(); }
  check(key, isPass, observed) { this.checks.push({ key, pass: Boolean(isPass), observed }); }
  step(key, value) { this.steps[key] = value; }
  result(error) {
    return { outcome: !error && this.checks.length > 0 && this.checks.every((check) => check.pass) ? "pass" : "failed",
      durationMs: Date.now() - this.startedAt, checks: this.checks, steps: this.steps, ...(error ? { error: sanitize(error.stack ?? error.message) } : {}) };
  }
}
async function finishProcesses(scenario, env) {
  await waitUntil(() => mock.openConnections() === 0, 5_000, "mock connections closed").catch(() => {});
  scenario.check("owned-processes-exited", owned.size === 0, { remaining: owned.size });
  scenario.check("mock-connections-closed", mock.openConnections() === 0, { open: mock.openConnections() });
  for (const child of owned) child.kill("SIGKILL");
  owned.clear();
  // Subprocesses started by Pi, such as the sidekick child Pi, carry the scenario temp root in their arguments. None may remain after exit.
  const leftovers = () => spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.includes(env.root));
  await waitUntil(() => leftovers().length === 0, 10_000, "descendant processes exited").catch(() => {});
  scenario.check("no-descendant-processes", leftovers().length === 0, { remaining: leftovers().length });
  const guard = await guardSummary(env);
  scenario.step("guard", guard);
  scenario.check("guard-active", guard.guardedProcesses > 0, { guardedProcesses: guard.guardedProcesses });
  scenario.check("no-blocked-commands", guard.blockedCommands.length === 0, guard.blockedCommands);
}

// ---------------------------------------------------------------------------------------------
// Scenarios

async function scenarioHelp(scenario) {
  const env = await createRoot("help");
  const result = await runPi(env, ["--help"]);
  scenario.check("help-exit-0", result.code === 0, { code: result.code });
  scenario.check("help-no-extension-error", !/Failed to load extension|Error:/i.test(result.stderr), excerpt(result.stderr, 300));
  scenario.check("help-no-devin-requests", mock.requests.length === scenario.requestBase, { requests: mock.requests.length - scenario.requestBase });
  if (isArtifactRun) {
    // Negative control: reading the source runtime must be refused under the same sandbox profile.
    const probe = spawn("/usr/bin/sandbox-exec", ["-f", env.profile, nodePath, "-e",
      "try { require('node:fs').readFileSync(process.argv[1]); console.log('readable'); } catch (error) { console.log(error.code); }", join(sourceRoot, "src/pi/adapters/pi/provider.ts")],
      { cwd: env.work, env: childEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    probe.stdout.on("data", (chunk) => { output += chunk; });
    await new Promise((done) => probe.on("close", done));
    scenario.check("source-runtime-denied", /^(EPERM|EACCES)$/.test(output.trim()), output.trim());
  }
  await finishProcesses(scenario, env);
}

async function scenarioRpc(scenario) {
  const env = await createRoot("rpc");
  const rpc = startRpc(env);
  try {
    const models = await waitForDevinModels(rpc);
    const ids = models.map((model) => model.id);
    // The first model's devin metadata holds the unavailable list for catalog restore. Exposure is judged by IDs and level mappings.
    const mappedUIDs = new Set(models.flatMap((model) => Object.values(model.thinkingLevelMap ?? {}).filter((uid) => typeof uid === "string")));
    const internalIDs = ids.filter((id) => id.includes(":"));
    scenario.step("models", { devin: ids.length, fusion: ids.filter((id) => id === FUSION_ID).length, internal: internalIDs.length, sample: ids.slice(0, 5) });
    // Exact UIDs covered by groups are hidden, so only 65 groups and 1 Fusion are listed. Names carry no internal notation or cost wording.
    // List IDs are human-readable slugs. The internal key (`family:`), `uid:` and base64 never appear.
    scenario.check("catalog-projection", ids.length === 66 && new Set(ids).size === 66 && internalIDs.length === 0 && ids.includes(FUSION_ID) && ids.includes(SWE2)
      && ids.includes("swe-2-fast-mode") && !models.some((model) => /[[\]=]|cost unknown/i.test(model.name)), { devin: ids.length, internal: internalIDs });
    scenario.check("unresolved-levels-unexposed", UNEXPOSED_UIDS.every((uid) => !mappedUIDs.has(uid) && !ids.includes(uid)) && mappedUIDs.size > 0,
      { uids: UNEXPOSED_UIDS, mappedUIDs: mappedUIDs.size });
    scenario.check("fusion-default-pairing", models.find((model) => model.id === FUSION_ID)?.name === "Devin Fusion · SWE-2 + SWE-2 Medium",
      models.find((model) => model.id === FUSION_ID)?.name);
    scenario.check("catalog-requests-oauth", mock.requests.length > scenario.requestBase && requestsSince(scenario.requestBase).every((entry) => entry.tokenMatches), { requests: mock.requests.length - scenario.requestBase });

    const setModel = await rpc.request({ type: "set_model", provider: "devin", modelId: SWE2 });
    const setLevel = await rpc.request({ type: "set_thinking_level", level: "high" });
    const state = await rpc.request({ type: "get_state" });
    scenario.check("set-model-and-level", setModel.success && setLevel.success && state.data?.model?.id === SWE2 && state.data?.thinkingLevel === "high",
      { model: state.data?.model?.id === SWE2, thinkingLevel: state.data?.thinkingLevel });

    // Unicode reply and a single terminal event
    let from = rpc.mark(), base = mock.requests.length;
    mock.setChat(() => ({ label: "unicode", frames: [{ messageId: "bot", deltaText: "Réponse ✅ " }, { deltaText: "𝔘𝔫𝔦 👋" }, STOP, USAGE], end: "ok" }));
    await rpc.request({ type: "prompt", message: "héllo 👋 — unicode check 𝔘" });
    await rpc.waitRecord((record) => record.type === "agent_settled", from, 30_000, "unicode settled");
    let run = runSummary(rpc.records.slice(from)), chats = chatsSince(base);
    scenario.step("unicode", { run, requests: chats.map(requestView) });
    scenario.check("rpc-unicode-text", run.finalText === "Réponse ✅ 𝔘𝔫𝔦 👋" && run.textDeltas >= 2, run.finalText);
    scenario.check("rpc-unicode-request", chats.length === 1 && chats[0].chatModelUid === "swe-2-high" && chats[0].lastUserText === "héllo 👋 — unicode check 𝔘"
      && chats[0].tokenMatches && chats[0].metadataKeyMatches, chats.map((entry) => entry.chatModelUid));
    scenario.check("rpc-terminal-once", run.agentEnds === 1 && run.settled.length === 1, { agentEnds: run.agentEnds, settled: run.settled.length });
    scenario.check("cache-default-marks", chats[0]?.cacheMarks?.[0] === "EPHEMERAL" && !chats[0]?.hasSystemPromptCacheOptions, chats[0]?.cacheMarks);
    await sleep(1_500);
    scenario.check("no-warming-requests", chatsSince(base).length === 1, { chatsAfterIdle: chatsSince(base).length });

    // One completed add tool call
    from = rpc.mark(); base = mock.requests.length;
    mock.setChat(sequence(toolPlan("add", { a: 2, b: 3 }, "tool", { split: true }), textPlan("The sum is 5 ✅", "tool-final")));
    await rpc.request({ type: "prompt", message: "add 2 and 3" });
    await rpc.waitRecord((record) => record.type === "agent_settled", from, 30_000, "tool settled");
    run = runSummary(rpc.records.slice(from)); chats = chatsSince(base);
    scenario.step("tool", { run, requests: chats.map(requestView) });
    scenario.check("rpc-tool-once", run.toolStarts.length === 1 && run.toolEnds[0]?.text === "5" && run.toolEnds[0]?.isError === false && run.toolcallDeltas >= 1, run.toolEnds);
    scenario.check("rpc-tool-result-forwarded", chats.length === 2 && chats[1].toolResults.includes("5") && run.finalText === "The sum is 5 ✅", { chats: chats.length, final: run.finalText });

    // Error after a partial tool call: 0 tool runs, an error terminal
    from = rpc.mark(); base = mock.requests.length;
    mock.setChat(() => failPlan("partial-error", [{ messageId: "bot", deltaToolCalls: [{ id: `call-partial-${++callCounter}`, name: "add", argumentsJson: '{"a":' }] }]));
    await rpc.request({ type: "prompt", message: "a failing tool" });
    await rpc.waitRecord((record) => record.type === "agent_settled", from, 60_000, "partial error settled");
    run = runSummary(rpc.records.slice(from)); chats = chatsSince(base);
    scenario.step("partialError", { run, chats: chats.length });
    scenario.check("rpc-partial-tool-not-run", run.toolStarts.length === 0 && run.stopReasons.at(-1) === "error" && run.settled.length === 1, run);

    // User cancel
    from = rpc.mark(); base = mock.requests.length;
    mock.setChat(() => hangPlan("abort"));
    await rpc.request({ type: "prompt", message: "cancel check" });
    await rpc.waitRecord((record) => record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta", from, 30_000, "abort delta");
    const abort = await rpc.request({ type: "abort" });
    await rpc.waitRecord((record) => record.type === "agent_settled", from, 30_000, "abort settled");
    await waitUntil(() => chatsSince(base)[0]?.clientClosedEarly, 5_000, "abort closes request").catch(() => {});
    run = runSummary(rpc.records.slice(from)); chats = chatsSince(base);
    scenario.step("abort", { run, chats: chats.map(requestView) });
    scenario.check("rpc-abort", abort.success && run.stopReasons.at(-1) === "aborted" && run.settled[0]?.aborted === true && chats[0]?.clientClosedEarly === true,
      { abort: abort.success, stopReason: run.stopReasons.at(-1), settled: run.settled, closed: chats[0]?.clientClosedEarly });
    await sleep(500);
    scenario.check("rpc-abort-no-followup", chatsSince(base).length === 1, { chats: chatsSince(base).length });

    // /devin-fusion: a pair chosen by arguments is saved in the agent directory and reflected in the model name at once.
    const fusionName = async () => (await rpc.request({ type: "get_available_models" })).data?.models?.find((model) => model.id === FUSION_ID)?.name;
    await rpc.request({ type: "prompt", message: `/devin-fusion ${SWE2} swe-2-high` });
    let selectedName;
    for (let attempt = 0; attempt < 50 && !selectedName?.includes("+ SWE-2 High"); attempt++) { selectedName = await fusionName(); await sleep(100); }
    const settingsPath = join(env.agent, "pi-devin", "fusion.json");
    const saved = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : undefined;
    scenario.check("fusion-command-saves-and-applies", saved?.schemaVersion === 1 && saved.leadID === SWE2 && saved.sidekickID === "swe-2-high"
      && selectedName === "Devin Fusion · SWE-2 + SWE-2 High", { saved, name: selectedName });
    await rpc.request({ type: "prompt", message: `/devin-fusion ${SWE2} swe-2-medium` });
    for (let attempt = 0; attempt < 50 && !(await fusionName())?.includes("+ SWE-2 Medium"); attempt++) await sleep(100);

    // /devin: the recommended filter is saved globally and applied to the list at once without network. RPC writes no status line and sends details as a notification.
    const devinModels = async () => ((await rpc.request({ type: "get_available_models" })).data?.models ?? []).filter((model) => model.provider === "devin");
    const devinIDs = async () => (await devinModels()).map((model) => model.id);
    // Expected from the catalog's isRecommended: models that map a recommended UID, plus Fusion, with the default list's level mappings unchanged.
    const recommendedUIDs = new Set(JSON.parse(readFileSync(catalogPath, "utf8")).clientModelConfigs.filter((config) => config.isRecommended === true).map((config) => config.modelUid));
    const defaultModels = await devinModels();
    const recommendedModels = defaultModels.filter((model) => model.id === FUSION_ID || Object.values(model.thinkingLevelMap ?? {}).some((uid) => recommendedUIDs.has(uid)));
    const levelMaps = (list) => JSON.stringify(list.map((model) => [model.id, model.thinkingLevelMap]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const devinFrom = rpc.mark(), devinBase = mock.requests.length;
    await rpc.request({ type: "prompt", message: "/devin recommended on" });
    let listed = [], filteredModels = [];
    for (let attempt = 0; attempt < 50 && (filteredModels = await devinModels()).length !== recommendedModels.length; attempt++) await sleep(100);
    const devinSettingsPath = join(env.agent, "pi-devin", "settings.json");
    const readDevinSettings = () => existsSync(devinSettingsPath) ? JSON.parse(readFileSync(devinSettingsPath, "utf8")) : undefined;
    const filteredSettings = readDevinSettings();
    scenario.check("devin-recommended-filter", recommendedUIDs.size > 0 && recommendedModels.length < defaultModels.length
      && levelMaps(filteredModels) === levelMaps(recommendedModels)
      && filteredSettings?.schemaVersion === 1 && filteredSettings.recommendedOnly === true, { listed: filteredModels.length, expected: recommendedModels.length, saved: filteredSettings });
    await rpc.request({ type: "prompt", message: "/devin recommended off" });
    for (let attempt = 0; attempt < 50 && (listed = await devinIDs()).length !== 66; attempt++) await sleep(100);
    await rpc.request({ type: "prompt", message: "/devin status on" });
    await rpc.request({ type: "prompt", message: "/devin" });
    const devinUI = () => rpc.records.slice(devinFrom).filter((record) => record.type === "extension_ui_request");
    await waitUntil(() => devinUI().some((record) => record.method === "notify" && record.message?.includes("Account quota")), 5_000, "devin report").catch(() => {});
    const devinReport = devinUI().find((record) => record.method === "notify" && record.message?.includes("Account quota"))?.message ?? "";
    scenario.step("devinReport", sanitize(devinReport));
    scenario.check("devin-command-rpc", listed.length === 66 && /Daily +▕█{10}▏ 100% left/.test(devinReport) && /Usage in status line on/.test(devinReport) && readDevinSettings()?.showUsageStatus === true
      && !devinUI().some((record) => record.method === "setStatus" && record.statusKey === "devin-usage")
      && requestsSince(devinBase).every((entry) => entry.method !== "GetCliModelConfigs" && entry.method !== "GetChatMessage"),
    { listed: listed.length, requests: requestsSince(devinBase).map((entry) => entry.method) });
    await rpc.request({ type: "prompt", message: "/devin status off" });

    // Fusion replies are chosen by the last message, not the request order. In the background, lead and sidekick requests can overlap.
    const fusionPlan = (block) => (entry) => {
      const last = entry.lastPrompt ?? { source: "", text: "" };
      if (entry.hasSidekickPrompt && !entry.tools.includes("devin_sidekick")) {
        return last.source === "TOOL" ? textPlan("sidekick report: 5", "sidekick-report") : toolPlan("add", { a: 2, b: 3 }, "sidekick");
      }
      if (last.source === "USER" && last.text.startsWith(REPORT_PREFIX)) return textPlan("background report received: 5 ✅", "lead-woken");
      if (last.source === "TOOL") return textPlan(block ? "final: 5 ✅" : "handed off to the background", block ? "lead-final" : "lead-after-background");
      return toolPlan("devin_sidekick", { message: "add 2 and 3 with the add tool and report back", ...(block ? {} : { block: false }) }, "lead");
    };

    // Fusion waiting mode: lead → child Pi sidekick (add) → lead
    await rpc.request({ type: "set_model", provider: "devin", modelId: FUSION_ID });
    await rpc.request({ type: "set_thinking_level", level: "high" });
    from = rpc.mark(); base = mock.requests.length;
    mock.setChat(fusionPlan(true));
    await rpc.request({ type: "prompt", message: "2+3 with Fusion" });
    await rpc.waitRecord((record) => record.type === "agent_settled", from, 120_000, "fusion settled");
    run = runSummary(rpc.records.slice(from)); chats = chatsSince(base);
    scenario.step("fusion", { run, requests: chats.map(requestView) });
    const uids = chats.map((entry) => entry.chatModelUid);
    scenario.check("fusion-request-sequence", JSON.stringify(uids) === JSON.stringify(["swe-2-high", "swe-2-medium", "swe-2-medium", "swe-2-high"]), uids);
    scenario.check("fusion-lead-guidance-and-tools", chats[0]?.hasFusionGuidance && chats[0]?.tools.includes("devin_sidekick") && chats[1]?.hasSidekickPrompt
      && !chats[1]?.hasFusionGuidance && JSON.stringify(chats[1]?.tools) === JSON.stringify(["add"]), chats.map((entry) => ({ guidance: entry.hasFusionGuidance, sidekick: entry.hasSidekickPrompt, tools: entry.tools })));
    scenario.check("fusion-separate-conversation", chats[0]?.cascade !== chats[1]?.cascade && chats[1]?.cascade === chats[2]?.cascade && chats[0]?.cascade === chats[3]?.cascade,
      chats.map((entry) => entry.cascade));
    scenario.check("fusion-report-to-lead", chats[2]?.toolResults.includes("5") && chats[3]?.lastPrompt?.text.includes("sidekick report: 5") && run.finalText === "final: 5 ✅",
      { sidekickToolResult: chats[2]?.toolResults, leadLast: chats[3]?.lastPrompt, final: run.finalText });
    scenario.check("fusion-sidekick-runs-in-child", run.toolStarts.join(",") === "devin_sidekick" && chats.every((entry) => entry.tokenMatches), { leadTools: run.toolStarts });
    const leadState = await rpc.request({ type: "get_state" });
    const sidekickSession = join(env.agent, "pi-devin", "sidekick", `${leadState.data?.sessionId}.jsonl`);
    scenario.check("fusion-sidekick-session-file", existsSync(sidekickSession) && statSync(sidekickSession).size > 0, { exists: existsSync(sidekickSession) });

    // Fusion background: block:false returns at once, and the report wakes the lead once more.
    from = rpc.mark(); base = mock.requests.length;
    mock.setChat(fusionPlan(false));
    await rpc.request({ type: "prompt", message: "2+3 with Fusion in the background" });
    await rpc.waitRecord((record) => record.type === "agent_settled", from, 120_000, "background lead settled");
    // A report during the lead run continues as a followUp of that run; after it, as a new run. Both are correct.
    await waitUntil(() => runSummary(rpc.records.slice(from)).finalText === "background report received: 5 ✅"
      && rpc.records.slice(from).at(-1)?.type === "agent_settled", 120_000, "background report wakes lead").catch(() => {});
    await sleep(1_000);
    run = runSummary(rpc.records.slice(from)); chats = chatsSince(base);
    scenario.step("fusionBackground", { run, requests: chats.map(requestView) });
    const leadChats = chats.filter((entry) => entry.tools.includes("devin_sidekick")), childChats = chats.filter((entry) => entry.hasSidekickPrompt);
    const reports = rpc.records.slice(from).filter((record) => record.type === "message_end" && record.message?.role === "custom" && record.message?.customType === "devin-sidekick-report");
    scenario.check("fusion-background-returns-immediately", run.toolEnds.some((tool) => tool.tool === "devin_sidekick" && tool.text.includes("background")) && leadChats[1]?.lastPrompt?.source === "TOOL",
      { toolEnds: run.toolEnds });
    scenario.check("fusion-background-report-once", reports.length === 1 && leadChats.length === 3 && childChats.length === 2
      && leadChats[2]?.lastPrompt?.text.startsWith(REPORT_PREFIX) && leadChats[2]?.lastPrompt?.text.includes("sidekick report: 5")
      && run.settled.length >= 1 && run.finalText === "background report received: 5 ✅", { reports: reports.length, lead: leadChats.length, child: childChats.length, settled: run.settled.length, final: run.finalText });

    // Even after the sidekick child Pi ran, neither the lead list nor the shared stored list has sidekick-only exact models.
    const afterSidekick = ((await rpc.request({ type: "get_available_models" })).data?.models ?? []).filter((model) => model.provider === "devin").map((model) => model.id);
    const storePath = join(env.agent, "models-store.json");
    const storeText = existsSync(storePath) ? readFileSync(storePath, "utf8") : "";
    const sidekickOnly = ["swe-2-medium", "swe-2-high", "swe-2-max"];
    const storedSidekick = sidekickOnly.filter((id) => new RegExp(`"id":\\s*"${id}"`).test(storeText));
    scenario.check("sidekick-models-not-listed", afterSidekick.length === 66 && !afterSidekick.some((id) => sidekickOnly.includes(id)) && storeText.length > 0 && storedSidekick.length === 0,
      { listed: afterSidekick.length, storedSidekick });

    // Leaving Fusion deactivates the sidekick
    await rpc.request({ type: "set_model", provider: "devin", modelId: SWE2 });
    from = rpc.mark(); base = mock.requests.length;
    mock.setChat(() => textPlan("plain model", "plain"));
    await rpc.request({ type: "prompt", message: "with a plain model" });
    await rpc.waitRecord((record) => record.type === "agent_settled", from, 30_000, "plain settled");
    chats = chatsSince(base);
    scenario.check("fusion-sidekick-deactivated", chats.length === 1 && !chats[0].tools.includes("devin_sidekick") && !chats[0].hasFusionGuidance, chats.map((entry) => entry.tools));

    // No model request limit: a long tool loop runs until the model stops
    from = rpc.mark(); base = mock.requests.length;
    mock.setChat((_entry, index) => index <= TOOL_ROUNDS ? toolPlan("add", { a: index, b: 1 }, "rounds") : textPlan("rounds done", "rounds"));
    await rpc.request({ type: "prompt", message: "keep adding" });
    await rpc.waitRecord((record) => record.type === "agent_settled", from, 60_000, "rounds settled");
    run = runSummary(rpc.records.slice(from)); chats = chatsSince(base);
    scenario.step("rounds", { chats: chats.length, toolRuns: run.toolStarts.length, stopReason: run.stopReasons.at(-1), errorMessage: run.errorMessage });
    scenario.check("no-request-limit", chats.length === TOOL_ROUNDS + 1 && run.toolStarts.length === TOOL_ROUNDS && run.stopReasons.at(-1) === "stop",
      { chats: chats.length, toolRuns: run.toolStarts.length, error: run.errorMessage });

    // stdin closed during a stream (shutdown)
    from = rpc.mark(); base = mock.requests.length;
    mock.setChat(() => hangPlan("shutdown"));
    await rpc.request({ type: "prompt", message: "shutdown check" });
    await rpc.waitRecord((record) => record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta", from, 30_000, "shutdown delta");
    const endAt = Date.now();
    rpc.child.stdin.end();
    const exit = await Promise.race([rpc.exited, sleep(20_000).then(() => undefined)]);
    await waitUntil(() => chatsSince(base)[0]?.clientClosedEarly, 5_000, "shutdown closes request").catch(() => {});
    scenario.step("shutdown", { exitCode: exit?.code ?? null, exitAfterMs: exit ? exit.atMs - endAt : null, closed: chatsSince(base)[0]?.clientClosedEarly ?? false });
    scenario.check("rpc-shutdown-during-stream", exit !== undefined && exit.code === 0 && chatsSince(base)[0]?.clientClosedEarly === true, scenario.steps.shutdown);
    scenario.check("rpc-jsonl-valid", rpc.invalid.length === 0, { records: rpc.records.length, invalid: rpc.invalid.map(sanitize) });
    scenario.check("rpc-no-requests-after-exit", (await sleep(500), chatsSince(base).length === 1), { chats: chatsSince(base).length });
  } finally {
    if (rpc.exit() === undefined) rpc.child.kill("SIGKILL");
    scenario.step("stderr", excerpt(rpc.stderr(), 400));
  }
  await finishProcesses(scenario, env);
}

async function scenarioPrint(scenario) {
  const env = await createRoot("print");
  scenario.step("seed", await seedCatalog(env));
  let base = mock.requests.length;
  mock.setChat(sequence(toolPlan("add", { a: 2, b: 3 }, "print"), textPlan("The sum is 5 ✅", "print-final")));
  let result = await runPi(env, ["-p", "add 2 and 3 🧮", "--model", `devin/${SWE2}`, "--thinking", "high"]);
  let chats = chatsSince(base);
  scenario.step("tool", { code: result.code, stdout: excerpt(result.stdout, 200), stderr: excerpt(result.stderr, 300), requests: chats.map(requestView), durationMs: result.durationMs });
  scenario.check("print-tool-flow", result.code === 0 && result.stdout.trim() === "The sum is 5 ✅", { code: result.code, stdout: excerpt(result.stdout, 120) });
  scenario.check("print-requests", chats.length === 2 && chats.every((entry) => entry.chatModelUid === "swe-2-high" && entry.tokenMatches) && chats[1].toolResults.includes("5"),
    chats.map((entry) => entry.chatModelUid));

  base = mock.requests.length;
  mock.setChat(() => failPlan("print-error"));
  result = await runPi(env, ["-p", "failure", "--model", `devin/${SWE2}`]);
  chats = chatsSince(base);
  scenario.step("error", { code: result.code, stdout: excerpt(result.stdout, 200), stderr: excerpt(result.stderr, 300), chats: chats.length });
  scenario.check("print-error-exit", result.code !== 0 && /host-contract scripted failure/.test(result.stdout + result.stderr), { code: result.code });

  base = mock.requests.length;
  mock.setChat(() => ({ label: "unauthenticated", frames: [], end: { code: "unauthenticated", message: "host-contract expired session" } }));
  result = await runPi(env, ["-p", "expired", "--model", `devin/${SWE2}`]);
  chats = chatsSince(base);
  const authAfter = await readAuth(env);
  scenario.step("unauthenticated", { code: result.code, stdout: excerpt(result.stdout, 200), stderr: excerpt(result.stderr, 300), chats: chats.length,
    credentialKept: authAfter.devin?.type === "oauth" });
  scenario.check("print-401-exit", result.code !== 0 && chats.length === 1, { code: result.code, chats: chats.length });

  base = mock.requests.length;
  mock.setChat(() => textPlan("recovered ✅", "after-401"));
  result = await runPi(env, ["-p", "again", "--model", `devin/${SWE2}`]);
  scenario.step("after401", { code: result.code, stdout: excerpt(result.stdout, 120), chats: chatsSince(base).length });
  scenario.check("print-after-401", result.code === 0 && result.stdout.trim() === "recovered ✅", { code: result.code });
  await finishProcesses(scenario, env);
}

async function scenarioJson(scenario) {
  const env = await createRoot("json");
  scenario.step("seed", await seedCatalog(env));
  let base = mock.requests.length;
  mock.setChat(sequence(toolPlan("add", { a: 2, b: 3 }, "json", { split: true }), textPlan("JSON result 5 ✅", "json-final")));
  let result = await runPi(env, ["--mode", "json", "add 2 and 3", "--model", `devin/${SWE2}`, "--thinking", "high"]);
  let parsed = parseJsonl(result.stdout), run = runSummary(parsed.records);
  scenario.step("tool", { code: result.code, records: parsed.records.length, invalid: parsed.invalid.map(sanitize), run, stderr: excerpt(result.stderr, 300), chats: chatsSince(base).length });
  scenario.check("json-valid-stream", result.code === 0 && parsed.invalid.length === 0 && parsed.records[0]?.type === "session", { code: result.code, first: parsed.records[0]?.type });
  scenario.check("json-terminal-once", run.agentEnds === 1 && run.settled.length === 1, { agentEnds: run.agentEnds, settled: run.settled.length });
  scenario.check("json-partial-tool-deltas", run.toolcallDeltas >= 2 && run.toolStarts.length === 1 && run.toolEnds[0]?.text === "5", { deltas: run.toolcallDeltas, tools: run.toolEnds });
  scenario.check("json-final-text", run.finalText === "JSON result 5 ✅" && chatsSince(base).length === 2, run.finalText);

  base = mock.requests.length;
  mock.setChat(() => failPlan("json-partial-error", [{ messageId: "bot", deltaToolCalls: [{ id: `call-json-partial-${++callCounter}`, name: "add", argumentsJson: '{"a":' }] }]));
  result = await runPi(env, ["--mode", "json", "a failing tool", "--model", `devin/${SWE2}`]);
  parsed = parseJsonl(result.stdout); run = runSummary(parsed.records);
  scenario.step("partialError", { code: result.code, invalid: parsed.invalid.length, run, chats: chatsSince(base).length });
  scenario.check("json-partial-error", parsed.invalid.length === 0 && run.toolStarts.length === 0 && run.stopReasons.at(-1) === "error" && run.settled.length === 1, run);
  await finishProcesses(scenario, env);
}

async function scenarioOauth(scenario) {
  const env = await createRoot("oauth");
  scenario.step("seed", await seedCatalog(env));
  const prompt = ["-p", "auth check", "--model", `devin/${SWE2}`];
  const keyEnv = { DEVIN_API_KEY: FAKE_API_KEY, WINDSURF_API_KEY: FAKE_API_KEY };
  mock.setChat(() => textPlan("OAuth ✅", "oauth"));
  const attempt = async (key, credential, args, extraEnv, expectSuccess) => {
    await writeAuth(env, credential);
    const base = mock.requests.length;
    const result = await runPi(env, args, { extraEnv });
    const requests = requestsSince(base), output = result.stdout + result.stderr;
    const observed = { credential, code: result.code, requests: requests.length, chats: requests.filter((entry) => entry.method === "GetChatMessage").length,
      allOAuthToken: requests.every((entry) => entry.tokenMatches), oauthOnlyMessage: output.includes(OAUTH_ONLY_TEXT),
      apiKeyEchoed: output.includes(FAKE_API_KEY), output: excerpt(output.trim(), 240) };
    scenario.step(key, observed);
    if (expectSuccess) scenario.check(key, result.code === 0 && observed.chats === 1 && observed.allOAuthToken && !observed.apiKeyEchoed, observed);
    else scenario.check(key, result.code !== 0 && observed.requests === 0 && !observed.apiKeyEchoed, observed);
  };
  await attempt("cli-api-key-with-oauth", "oauth", [...prompt, "--api-key", FAKE_API_KEY], undefined, false);
  await attempt("env-api-keys-with-oauth", "oauth", prompt, keyEnv, true);
  await attempt("stored-api-key", "api_key", prompt, undefined, false);
  await attempt("env-api-keys-only", "none", prompt, keyEnv, false);
  await attempt("cli-api-key-only", "none", [...prompt, "--api-key", FAKE_API_KEY], undefined, false);
  await attempt("oauth-restored", "oauth", prompt, undefined, true);
  await finishProcesses(scenario, env);
}

async function scenarioCache(scenario) {
  const env = await createRoot("cache");
  scenario.step("seed", await seedCatalog(env));
  mock.setChat(() => textPlan("cache ✅", "cache"));
  const attempt = async (key, model, extraEnv, level) => {
    const base = mock.requests.length;
    const result = await runPi(env, ["-p", "cache check", "--model", `devin/${model}`, ...(level ? ["--thinking", level] : [])], { extraEnv });
    const chats = chatsSince(base);
    const observed = { code: result.code, chats: chats.map((entry) => ({ uid: entry.chatModelUid, marks: entry.cacheMarks, systemCache: entry.hasSystemPromptCacheOptions })),
      output: excerpt((result.stdout + result.stderr).trim(), 240) };
    scenario.step(key, observed);
    return { result, chats, observed };
  };
  let outcome = await attempt("default-swe2", SWE2);
  scenario.check("default-ephemeral-marks", outcome.result.code === 0 && outcome.chats.length === 1 && outcome.chats[0].cacheMarks[0] === "EPHEMERAL", outcome.observed);
  outcome = await attempt("long-swe2-rejected", SWE2, { PI_CACHE_RETENTION: "long" });
  scenario.check("long-rejected-before-request", outcome.result.code !== 0 && outcome.chats.length === 0 && outcome.observed.output.includes(LONG_CACHE_TEXT), outcome.observed);
  outcome = await attempt("long-sol-accepted", SOL, { PI_CACHE_RETENTION: "long" }, "medium");
  scenario.check("long-accepted-24h-model", outcome.result.code === 0 && outcome.chats.length === 1 && outcome.chats[0].chatModelUid === "gpt-5-6-sol-medium"
    && outcome.chats[0].cacheMarks[0] === "EPHEMERAL" && !outcome.chats[0].hasSystemPromptCacheOptions, outcome.observed);
  await finishProcesses(scenario, env);
}

async function scenarioTui(scenario) {
  const env = await createRoot("tui");
  scenario.step("seed", await seedCatalog(env));
  const { child, exited } = spawnPi(env, ["--model", `devin/${SWE2}`, "--thinking", "high"], { isTui: true });
  const decoder = new StringDecoder("utf8");
  let raw = "", exit;
  void exited.then((value) => { exit = value; });
  child.stdout.on("data", (chunk) => { raw += decoder.write(chunk); });
  child.stderr.setEncoding("utf8");
  let bridgeErr = "";
  child.stderr.on("data", (chunk) => { bridgeErr += chunk; });
  const screen = () => stripAnsi(raw);
  const snapshots = [];
  const snapshot = (label, from) => { snapshots.push({ label, screen: screenExcerpt(screen().slice(from)) }); };
  const type = async (text, settleMs = 250) => { child.stdin.write(text); await sleep(settleMs); };
  const submit = async (text) => { await type(text, 400); await type("\r", 400); };
  // The first Enter on a slash command may only pick the autocomplete item. Enter in an empty editor sends nothing.
  const command = async (text) => { await submit(text); await type("\r", 600); };
  // For commands that open a custom screen, Enter is pressed again only when the screen is not visible, so the second Enter never lands inside it.
  const openScreen = async (text, pattern, from, label) => {
    await submit(text);
    await waitUntil(() => pattern.test(screen().slice(from)), 1_500, label).catch(() => type("\r", 600));
    await waitScreen(pattern, from, 10_000, label);
    await sleep(300);
  };
  const waitScreen = (pattern, from, timeoutMs, label) => waitUntil(() => pattern.test(screen().slice(from)), timeoutMs, label);
  const promptAndWait = async (text, reply, label) => {
    const base = mock.requests.length, from = screen().length;
    mock.setChat(() => textPlan(reply, label));
    await submit(text);
    await waitUntil(() => chatsSince(base).length >= 1, 20_000, `${label} request`).catch((error) => { snapshot(`${label}-failed`, from); throw error; });
    await waitScreen(new RegExp(reply.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), from, 20_000, `${label} reply`);
    await sleep(500);
    return chatsSince(base);
  };
  try {
    await waitScreen(/swe-2/i, 0, 30_000, "tui ready");
    await sleep(1_500);
    let chats = await promptAndWait("hello TUI 👋", "TUI reply ✅", "tui-first");
    scenario.check("tui-prompt", chats.length === 1 && chats[0].chatModelUid === "swe-2-high" && chats[0].lastUserText === "hello TUI 👋" && chats[0].tokenMatches,
      chats.map(requestView));

    let from = screen().length;
    await command("/thinking max");
    snapshot("thinking-command", from);
    chats = await promptAndWait("max level", "max reply", "tui-thinking-command");
    scenario.check("tui-thinking-command", chats[0]?.chatModelUid === "swe-2-max", chats.map((entry) => entry.chatModelUid));

    await type("\x1b[Z", 600);
    chats = await promptAndWait("cycled level", "cycle reply", "tui-thinking-cycle");
    scenario.step("thinkingCycleUid", chats[0]?.chatModelUid);
    scenario.check("tui-thinking-cycle", chats[0] !== undefined && chats[0].chatModelUid !== "swe-2-max" && /^swe-2-(medium|high)$/.test(chats[0].chatModelUid), chats.map((entry) => entry.chatModelUid));

    // Picking Devin Fusion with /model sends a lead request with the sidekick tool on. The thinking level follows the previous shift+tab.
    await command(`/model devin/${FUSION_ID}`);
    chats = await promptAndWait("model selection check", "selection reply", "tui-model-select");
    scenario.check("tui-model-select", chats[0]?.chatModelUid === scenario.steps.thinkingCycleUid && chats[0]?.tools.includes("devin_sidekick") && chats[0]?.hasFusionGuidance,
      chats.map((entry) => ({ uid: entry.chatModelUid, tools: entry.tools })));

    // Sidekick-only exact models appear in neither /model nor /scoped-models.
    from = screen().length;
    await openScreen("/scoped-models", /Model Configuration/, from, "scoped models");
    await waitScreen(/\(\d+\/\d+\)/, from, 5_000, "scoped models list").catch(() => {});
    const scopedTotal = screen().slice(from).match(/\(\d+\/\d+\)/g)?.at(-1);
    await type("swe-2-medium", 800);
    const scopedScreen = screen().slice(from);
    await type("\x1b", 600); await type("\x1b", 600);
    from = screen().length;
    await openScreen("/model", /Model Name:/, from, "model selector");
    const selectorTotal = screen().slice(from).match(/\(\d+\/\d+\)/g)?.at(-1);
    await type("swe-2-medium", 800);
    const selectorScreen = screen().slice(from);
    await type("\x1b", 600); await type("\x1b", 600);
    // The query also matches the Fusion name (`… + SWE-2 Medium`), so only item rows are checked for the sidekick variant ID.
    const listsSidekick = (text) => /swe-2-medium \[devin\]/.test(text.slice(text.lastIndexOf("swe-2-medium")));
    scenario.check("tui-selectors-hide-sidekick-models", scopedTotal === "(1/66)" && selectorTotal === "(1/66)" && !listsSidekick(scopedScreen) && !listsSidekick(selectorScreen),
    { scopedTotal, selectorTotal, scopedAfterSearch: compactScreen(scopedScreen.slice(scopedScreen.lastIndexOf("swe-2-medium"))).slice(0, 160),
      selectorAfterSearch: compactScreen(selectorScreen.slice(selectorScreen.lastIndexOf("swe-2-medium"))).slice(0, 160) });

    // /devin-fusion: in the two-column screen, move to the sidekick column, search, and save it together with the lead using Enter.
    from = screen().length;
    await openScreen("/devin-fusion", /choose the lead and sidekick on one screen/, from, "fusion picker");
    const pickerScreen = screen().slice(from);
    await type("\t", 300);
    await type("swe-2-max", 600);
    const pickerSelection = compactScreen(screen().slice(from)).match(/Selected: .+? \+ .+?(?=tab switch column|\n|$)/g)?.at(-1)?.slice(0, 80);
    await type("\r", 1_000);
    const fusionPath = join(env.agent, "pi-devin", "fusion.json");
    await waitUntil(() => existsSync(fusionPath), 5_000, "fusion picker saved").catch(() => {});
    const pickedFusion = existsSync(fusionPath) ? JSON.parse(readFileSync(fusionPath, "utf8")) : undefined;
    snapshot("fusion-picker", from);
    scenario.check("tui-fusion-picker", /▸ LEAD \d+\/\d+/.test(pickerScreen) && /SIDEKICK \d+\/\d+/.test(pickerScreen) && /Current: SWE-2 \+ SWE-2 Medium/.test(pickerScreen)
      && pickedFusion?.schemaVersion === 1 && pickedFusion.leadID === SWE2 && pickedFusion.sidekickID === "swe-2-max"
      && /Saved Devin Fusion · SWE-2 \+ SWE-2 Max/.test(compactScreen(screen().slice(from))),
    { saved: pickedFusion, selection: pickerSelection });

    // /devin: view usage details and turn on the status toggle; it is saved globally and usage appears in the footer.
    from = screen().length;
    await openScreen("/devin", /usage and display settings/, from, "devin panel");
    const panelScreen = compactScreen(screen().slice(from));
    await type("\x1b[B", 300);
    await type(" ", 1_000);
    const devinSettingsPath = join(env.agent, "pi-devin", "settings.json");
    const devinSaved = existsSync(devinSettingsPath) ? JSON.parse(readFileSync(devinSettingsPath, "utf8")) : undefined;
    await type("\x1b", 800);
    snapshot("devin-panel", from);
    scenario.check("tui-devin-panel", /Account quota · fetched .* · not live/.test(panelScreen) && /Daily +▕█{10}▏ 100% left/.test(panelScreen) && /This session · lead conversation/.test(panelScreen)
      && /\[ \] Usage in status line/.test(panelScreen) && devinSaved?.schemaVersion === 1 && devinSaved.showUsageStatus === true && devinSaved.recommendedOnly === false,
    { saved: devinSaved });
    from = screen().length;
    chats = await promptAndWait("status line check", "status reply", "tui-usage-status");
    const statusLine = compactScreen(screen().slice(from)).match(/devin day ▕[█░]{10}▏\d+% week ▕[█░]{10}▏\d+% · ↑\S+ ↓\S+/g)?.at(-1);
    scenario.check("tui-usage-status", statusLine !== undefined && chats.length === 1, { statusLine, chats: chats.length });

    let base = mock.requests.length;
    from = screen().length;
    mock.setChat(() => hangPlan("tui-abort"));
    await submit("cancel test");
    await waitUntil(() => chatsSince(base)[0]?.hung, 20_000, "tui abort request");
    await waitScreen(/partial reply/, from, 20_000, "tui partial text");
    await type("\x1b", 1_000);
    await waitUntil(() => chatsSince(base)[0]?.clientClosedEarly, 10_000, "tui abort closes request").catch(() => {});
    await sleep(800);
    const abortScreen = screen().slice(from);
    scenario.step("abortScreen", screenExcerpt(abortScreen, 300));
    scenario.check("tui-escape-abort", chatsSince(base)[0]?.clientClosedEarly === true && chatsSince(base).length === 1 && /Operation aborted/.test(abortScreen),
      { closed: chatsSince(base)[0]?.clientClosedEarly, chats: chatsSince(base).length, shown: /Operation aborted/.test(abortScreen) });

    from = screen().length;
    await command("/reload");
    await sleep(3_000);
    const reloadScreen = screen().slice(from);
    scenario.step("reloadScreen", screenExcerpt(reloadScreen, 300));
    chats = await promptAndWait("after reload", "reload reply", "tui-after-reload");
    scenario.check("tui-reload", /Reloaded/.test(reloadScreen) && chats.length === 1 && chats[0].tokenMatches,
      { reloaded: /Reloaded/.test(reloadScreen), chats: chats.map((entry) => ({ uid: entry.chatModelUid, tokenMatches: entry.tokenMatches })) });

    from = screen().length;
    await submit("/logout");
    await sleep(1_000);
    snapshot("logout", from);
    if (/devin/i.test(screen().slice(from)) && !/Logged out/.test(screen().slice(from))) await type("\r", 1_500);
    await waitScreen(/Logged out/, from, 10_000, "logout status").catch(() => {});
    const auth = await readAuth(env);
    scenario.step("logoutScreen", screenExcerpt(screen().slice(from), 300));
    scenario.check("tui-logout-removes-credential", auth.devin === undefined, { hasDevinCredential: auth.devin !== undefined });
    base = mock.requests.length; from = screen().length;
    mock.setChat(() => textPlan("reply after logout", "after-logout"));
    await submit("after logout");
    await sleep(3_000);
    const afterLogout = compactScreen(screen().slice(from));
    const logoutError = afterLogout.match(/Error:.*?(?= See:|$)/gm)?.at(-1);
    scenario.step("afterLogoutMessage", logoutError ? sanitizeScreen(logoutError).slice(0, 240) : null);
    scenario.check("tui-no-requests-after-logout", requestsSince(base).length === 0 && logoutError !== undefined, { requests: requestsSince(base).length, errorShown: logoutError !== undefined });

    const quitAt = Date.now();
    await command("/quit");
    await waitUntil(() => exit, 15_000, "tui exit").catch(() => {});
    scenario.step("exit", { code: exit?.code ?? null, afterQuitMs: exit ? exit.atMs - quitAt : null });
    scenario.check("tui-quit", exit?.code === 0, { code: exit?.code ?? null });
  } finally {
    if (exit === undefined) { child.stdin.end(); await Promise.race([exited, sleep(8_000)]); }
    if (exit === undefined) child.kill("SIGKILL");
    scenario.step("screenTail", screenExcerpt(screen()));
    scenario.step("snapshots", snapshots);
    if (bridgeErr) scenario.step("bridgeStderr", excerpt(bridgeErr, 300));
  }
  await finishProcesses(scenario, env);
}

// ---------------------------------------------------------------------------------------------

const python = which("python3");
const report = {
  schemaVersion: 1, kind: "pi-devin-host-contract", startedAt: new Date().toISOString(),
  host: { platform: `${process.platform}-${process.arch}`, node: process.version, piVersion: piPackage.version, piBin: relative(piRoot, piBin),
    packageRoot: isArtifactRun ? "<package>" : "<source>",
    sourceRuntimeReadable: !isArtifactRun,
    isolation: "sandbox-exec per Pi process (network: mock port only; HOME reads: repo/node/temp only; writes: temp root only) + Node guard preload log" },
  inputs: {
    packageRuntime: packageRuntimeDigest(packageRoot),
    catalogSha256: sha256(catalogPath),
    harness: Object.fromEntries([guardPath, addToolPath, bridgePath, fileURLToPath(import.meta.url), join(scriptDir, "host-contract/mock-devin.mjs")]
      .map((path) => [relative(sourceRoot, path), sha256(path)])),
  },
  scenarios: {},
};
let blockedReason;
if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) blockedReason = "sandbox-exec unavailable: isolation cannot be proven";
else if (!python) blockedReason = "python3 unavailable: TUI PTY cannot be owned";
else if (piPackage.version !== "1.3.0") blockedReason = `Pi ${piPackage.version} is not the pinned 1.3.0`;
if (blockedReason) {
  report.outcome = "blocked"; report.blockedReason = blockedReason;
} else {
  mock = await startMockDevin({ sourceRoot: pathToFileURL(sourceRoot + "/"), catalogPath });
  const runners = { help: scenarioHelp, rpc: scenarioRpc, print: scenarioPrint, json: scenarioJson, oauth: scenarioOauth, cache: scenarioCache, tui: scenarioTui };
  try {
    for (const name of selected) {
      const scenario = new Scenario(name);
      scenario.requestBase = mock.requests.length;
      callCounter = 0;
      let failure;
      try { await runners[name](scenario); } catch (error) { failure = error; }
      for (const child of owned) child.kill("SIGKILL");
      owned.clear();
      report.scenarios[name] = scenario.result(failure);
      const unexpected = requestsSince(scenario.requestBase).filter((entry) => entry.unexpected);
      if (unexpected.length) report.scenarios[name].unexpectedRequests = unexpected.map(requestView);
      console.log(`${name}: ${report.scenarios[name].outcome} (${report.scenarios[name].checks.filter((check) => check.pass).length}/${report.scenarios[name].checks.length})`);
    }
  } finally { await mock.close(); }
  const outcomes = Object.values(report.scenarios).map((scenario) => scenario.outcome);
  report.outcome = outcomes.every((outcome) => outcome === "pass") ? "pass" : "failed";
  report.totals = { scenarios: outcomes.length, checks: Object.values(report.scenarios).reduce((sum, scenario) => sum + scenario.checks.length, 0),
    passedChecks: Object.values(report.scenarios).reduce((sum, scenario) => sum + scenario.checks.filter((check) => check.pass).length, 0) };
}
report.completedAt = new Date().toISOString();
if (!values.keep) for (const root of roots) await rm(root, { recursive: true, force: true });
report.tempRootsRemoved = !values.keep && roots.every((root) => !existsSync(root));
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(`${report.outcome} → ${relative(process.cwd(), reportPath)}`);
process.exitCode = report.outcome === "pass" ? 0 : 1;
