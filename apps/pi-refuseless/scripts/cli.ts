/**
 * Development CLI for trying the package by hand. Not shipped: package.json `files` lists only src/.
 *
 *   pnpm --filter @buyong/pi-refuseless cli <command> [options]
 */

import { type SpawnSyncOptions, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Provider,
} from "@earendil-works/pi-ai";
import { type ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import refuseless from "../src/index.ts";
import { catalogModels, REFUSELESS_BASE_URL, requestCatalog } from "../src/models.ts";
import { liveCheck, MAX_TURNS } from "./live-check.ts";
import { describeRequest, MOCK_CATALOG, startMockRefuseless } from "./mock-refuseless.ts";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI = "pnpm --filter @buyong/pi-refuseless cli";
const PI_ISOLATION = ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];

const USAGE = `Usage: ${CLI} <command> [options]

Commands:
  models [--dir DIR | --mock]  Fetch GET /v1/models and show the models as Pi registers them, then each
                               entry as reported. Uses the key saved in DIR by "pi --dir DIR", else
                               REFUSELESS_API_KEY.
  pi [--mock] [--dir DIR] [--package DIR] [-- <pi options>]
                               Start Pi with only this package, in its own agent directory.
                               --mock sends Refuseless requests to a local mock instead of the service.
                               --dir reuses a directory from an earlier run, keeping its login.
  mock [--port N]              Run the local mock API and print each request.
  live --model ID [--model ID ...] [--turns N] [--dir DIR]
                               Talk to each model on the real service through the installed pi, all
                               models at once, for N turns (1-10, default 10). Spends credits. Uses the
                               key saved in DIR by "pi --dir DIR", else REFUSELESS_API_KEY.
  verify                       Check the source package and its npm archive.
`;

class UsageError extends Error {}

/** The provider the extension registers, from a Pi API stub that ignores its event handlers and command. */
function registeredProvider(): Provider {
  let provider: Provider | undefined;
  refuseless({
    registerProvider: (value: Provider) => {
      provider = value;
    },
    on: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI);
  if (!provider) throw new Error("The extension registered no provider");
  return provider;
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** Points the Refuseless provider in `agentDir/models.json` at `baseUrl`, keeping other entries. */
async function setEndpointOverride(agentDir: string, baseUrl: string) {
  const path = join(agentDir, "models.json");
  const config = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
  config.providers = { ...config.providers, refuseless: { ...config.providers?.refuseless, baseUrl } };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

function endpointOverride(agentDir: string): string | undefined {
  const path = join(agentDir, "models.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")).providers?.refuseless?.baseUrl;
}

async function sandbox(dir: string | undefined) {
  const root = dir ? resolve(dir) : await mkdtemp(join(tmpdir(), "pi-refuseless-"));
  const agentDir = join(root, "agent");
  const workDir = join(root, "work");
  if (resolve(agentDir) === resolve(homedir(), ".pi", "agent")) {
    throw new UsageError("--dir must not be ~/.pi; its agent/ is your personal Pi configuration.");
  }
  await mkdir(agentDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  return { root, agentDir, workDir };
}

async function runPi(options: { mock?: boolean; dir?: string; package?: string }, piArgs: string[]) {
  const pi = installedPi();
  const { root, agentDir, workDir } = await sandbox(options.dir);
  const packageDir = resolve(options.package ?? PACKAGE_DIR);
  const override = endpointOverride(agentDir);
  if (!options.mock && override) {
    throw new UsageError(
      `${join(agentDir, "models.json")} sends Refuseless requests to ${override}. Add --mock or use another --dir.`,
    );
  }
  const logPath = join(root, "mock-requests.log");
  const mock = options.mock
    ? await startMockRefuseless({ onRequest: (request) => appendFileSync(logPath, `${describeRequest(request)}\n`) })
    : undefined;
  if (mock) await setEndpointOverride(agentDir, mock.baseUrl);

  console.log(`Pi ${pi.version}, agent directory: ${agentDir}`);
  console.log(mock ? `Requests: local mock ${mock.baseUrl}, logged to ${logPath}` : `Requests: ${REFUSELESS_BASE_URL}`);
  const child = spawn(pi.bin, [...PI_ISOLATION, "-e", packageDir, ...piArgs], {
    cwd: workDir,
    stdio: "inherit",
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  const code = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolveExit(exitCode ?? (signal ? 1 : 0)));
  }).finally(() => mock?.close());
  console.log(`Run again in this directory: ${CLI} pi --dir ${root}${mock ? " --mock" : ""}`);
  return code;
}

async function runMock(options: { port?: string }) {
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new UsageError(`Invalid --port: ${options.port}`);
  const mock = await startMockRefuseless({ port, onRequest: (request) => console.log(describeRequest(request)) });
  console.log(`Mock Refuseless API: ${mock.baseUrl} (keys starting with abl_ are accepted; Ctrl+C stops)`);
  await new Promise<void>((resolveStop) => process.once("SIGINT", () => resolveStop()));
  await mock.close();
  return 0;
}

/** The key Pi would use: the credential saved in `dir`, else REFUSELESS_API_KEY. */
async function piApiKey(dir: string | undefined): Promise<string | undefined> {
  const runtime = await ModelRuntime.create({
    ...(dir ? { authPath: join(resolve(dir), "agent", "auth.json") } : { credentials: new InMemoryCredentialStore() }),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(registeredProvider());
  return (await runtime.getAuth("refuseless"))?.auth.apiKey;
}

/** The models Pi gets from `GET /v1/models` with the key Pi would use, and the entries as reported. */
async function showModels(options: { dir?: string; mock?: boolean }) {
  if (options.dir && options.mock) throw new UsageError("Use either --dir or --mock.");
  const mock = options.mock ? await startMockRefuseless() : undefined;
  try {
    const baseUrl = mock?.baseUrl ?? REFUSELESS_BASE_URL;
    const key = mock ? "abl_mock-key" : await piApiKey(options.dir);
    if (!key) {
      throw new UsageError(
        options.dir
          ? `No Refuseless key in ${options.dir}. Log in there with "${CLI} pi --dir ${options.dir}" first.`
          : `No key. Set REFUSELESS_API_KEY, or pass --dir from "${CLI} pi".`,
      );
    }
    const entries = await requestCatalog(baseUrl, key);
    const rows = catalogModels(entries).map((model) => [
      model.id,
      String(model.contextWindow),
      String(model.maxTokens),
      getSupportedThinkingLevels(model).join(", "),
      model.reasoningDefault ?? "-",
      model.abliterated === undefined ? "-" : model.abliterated ? "yes" : "no",
    ]);
    console.log(`GET ${baseUrl}/models`);
    console.log(table([["ID", "Context", "Max output", "Thinking", "Default", "Abliterated"], ...rows]));
    console.log("\nCatalog entries as reported:");
    for (const entry of entries) console.log(JSON.stringify(entry));
    return 0;
  } finally {
    await mock?.close();
  }
}

/**
 * The `pi` command the user runs: the first on PATH outside this repository. pnpm puts the workspace's
 * development copy (node_modules/.bin) first while running scripts; that copy is skipped.
 */
function installedPi(): { bin: string; root: string; version: string } {
  const repository = resolve(PACKAGE_DIR, "..", "..");
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry || resolve(entry).startsWith(repository)) continue;
    const bin = join(entry, "pi");
    if (!existsSync(bin)) continue;
    for (let dir = dirname(realpathSync(bin)); dirname(dir) !== dir; dir = dirname(dir)) {
      const manifestPath = join(dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === "@earendil-works/pi-coding-agent") return { bin, root: dir, version: manifest.version };
    }
  }
  throw new Error("No installed pi on PATH (outside this repository).");
}

/**
 * Starts the installed Pi in RPC mode, which refreshes model catalogs in the background, and asks for the
 * available models until the Refuseless list arrives (it is saved before Pi publishes it). Returns how many
 * Refuseless models Pi listed.
 */
async function rpcModelList(bin: string, packageDir: string, agentDir: string, workDir: string): Promise<number> {
  const rpc = spawn(bin, [...PI_ISOLATION, "-e", packageDir, "--mode", "rpc"], {
    cwd: workDir,
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  let count = 0;
  let pending = "";
  rpc.stdout.on("data", (data) => {
    pending += data;
    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        const models = JSON.parse(line).data?.models;
        if (Array.isArray(models)) count = models.filter((model) => model.provider === "refuseless").length;
      } catch {}
    }
  });
  const exited = new Promise((resolveExit) => rpc.once("exit", resolveExit));
  const deadline = Date.now() + 30_000;
  for (let id = 0; count < MOCK_CATALOG.length && Date.now() < deadline; id++) {
    rpc.stdin.write(`${JSON.stringify({ id: String(id), type: "get_available_models" })}\n`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  rpc.kill("SIGTERM");
  await exited;
  return count;
}

async function verify() {
  const reports = await mkdtemp(join(tmpdir(), "pi-refuseless-verify-"));
  const results: [string, boolean, string?][] = [];
  const record = (name: string, ok: boolean, detail?: string) => {
    results.push([name, ok, detail]);
    console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
    return ok;
  };
  const run = (command: string, args: string[], options: SpawnSyncOptions = {}) =>
    spawnSync(command, args, { cwd: PACKAGE_DIR, encoding: "utf8", ...options });
  const pi = installedPi();
  const versions = `Pi ${pi.version} (${pi.bin}), Node ${process.version}`;
  console.log(`${versions}; reports in ${reports}`);

  const inventoryPath = join(PACKAGE_DIR, "verification", "inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const validate = (dir: string, name: string, extra: string[]) => {
    const reportPath = join(reports, `${name}.json`);
    const result = run(process.execPath, [
      join(PACKAGE_DIR, "verification", "scripts", "validate-package.mjs"),
      dir,
      "--expect",
      inventoryPath,
      "--runtime",
      "--pi-root",
      pi.root,
      ...extra,
      "--report",
      reportPath,
    ]);
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
    const failed = (report?.checks ?? [])
      .filter((check: any) => check.status === "fail")
      .map((check: any) => check.name);
    record(`validator: ${name}`, result.status === 0, failed.length ? `failed: ${failed.join("; ")}` : reportPath);
    return report;
  };

  const workspacePi = JSON.parse(
    readFileSync(join(PACKAGE_DIR, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"),
  ).version;
  /** The TUI flow tests on the installed Pi, for `packageDir`. */
  const tuiTests = (packageDir: string) =>
    run("pnpm", ["exec", "vitest", "run", "test/integration.test.ts"], {
      stdio: "inherit",
      env: { ...process.env, REFUSELESS_PACKAGE_DIR: packageDir, REFUSELESS_PI_SDK: pi.root },
    }).status === 0;

  const tests = run("pnpm", ["exec", "vitest", "run"], { stdio: "inherit" });
  record(`all tests: source, workspace Pi ${workspacePi}`, tests.status === 0);
  record(`TUI flow tests: source, installed Pi ${pi.version}`, tuiTests(PACKAGE_DIR));

  const source = validate(PACKAGE_DIR, "source", ["--pack"]);
  const archiveDir: string | undefined = source?.artifact?.packageDir;
  const packed: string[] = [...(source?.artifact?.files ?? [])].sort();
  const expectedFiles = [...inventory.requiredFiles].sort();
  record(
    "archive contains exactly the shipped files",
    JSON.stringify(packed) === JSON.stringify(expectedFiles),
    packed.join(", "),
  );
  if (archiveDir) {
    validate(archiveDir, "archive", []);
    record(`TUI flow tests: archive, installed Pi ${pi.version}`, tuiTests(archiveDir), archiveDir);
  } else {
    record("archive available", false);
  }

  for (const [name, dir] of [
    ["source", PACKAGE_DIR],
    ["archive", archiveDir],
  ] as const) {
    if (!dir) continue;
    const mock = await startMockRefuseless();
    const printRoot = await mkdtemp(join(tmpdir(), "pi-refuseless-print-"));
    try {
      const { agentDir, workDir } = await sandbox(printRoot);
      await setEndpointOverride(agentDir, mock.baseUrl);
      await writeFile(
        join(agentDir, "auth.json"),
        JSON.stringify({ refuseless: { type: "api_key", key: "abl_verify" } }),
        {
          mode: 0o600,
        },
      );
      const listed = await rpcModelList(pi.bin, dir, agentDir, workDir);
      const listRequest = mock.requests.find((request) => request.path === "/v1/models");
      record(
        `installed pi fetches the model list: ${name}`,
        listed === MOCK_CATALOG.length && listRequest?.authorization === "Bearer abl_verify",
        `${listed} Refuseless models after an RPC-mode start`,
      );
      const child = spawn(
        pi.bin,
        [...PI_ISOLATION, "-e", dir, "--model", "refuseless/glm-5.3-flash-abliterated", "-p", "Say ok."],
        {
          cwd: workDir,
          // Print mode reads piped stdin until it closes.
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
        },
      );
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      const code = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
      clearTimeout(timer);
      const request = mock.requests.at(-1);
      record(
        `installed pi -p request with the saved list: ${name}`,
        code === 0 &&
          output.includes("Mock Refuseless reply from glm-5.3-flash-abliterated") &&
          request?.authorization === "Bearer abl_verify",
        code === 0 ? request && describeRequest(request) : output.trim().slice(-500),
      );
    } finally {
      await mock.close();
      await rm(printRoot, { recursive: true, force: true });
    }
  }

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `${failed} check(s) failed.` : `All ${results.length} checks passed.`);
  await writeFile(join(reports, "summary.json"), `${JSON.stringify({ versions, results }, null, 2)}\n`);
  return failed ? 1 : 0;
}

async function runLive(options: { model?: string[]; turns?: string; dir?: string }) {
  const models = options.model ?? [];
  if (models.length === 0) throw new UsageError("Pass at least one --model.");
  const turns = options.turns === undefined ? MAX_TURNS : Number(options.turns);
  if (!Number.isInteger(turns) || turns < 1 || turns > MAX_TURNS) {
    throw new UsageError(`--turns must be 1-${MAX_TURNS}.`);
  }
  const key = await piApiKey(options.dir);
  if (!key) {
    throw new UsageError(
      options.dir
        ? `No Refuseless key in ${options.dir}.`
        : `No key. Set REFUSELESS_API_KEY, or pass --dir from "${CLI} pi".`,
    );
  }
  const pi = installedPi();
  console.log(
    `Pi ${pi.version}; ${models.length} model(s) × ${turns} turn(s) on the real service. Requests spend credits.`,
  );
  const { results, reportPath } = await liveCheck({
    bin: pi.bin,
    packageDir: PACKAGE_DIR,
    isolation: PI_ISOLATION,
    key,
    models,
    turns,
    log: (line) => console.log(line),
  });
  let failed = 0;
  for (const result of results) {
    const passed = result.turns.filter((turn) => turn.ok).length;
    const tokens = result.turns.reduce((sum, turn) => sum + turn.inputTokens + turn.outputTokens, 0);
    const ok = !result.error && passed === turns;
    if (!ok) failed++;
    console.log(
      `${ok ? "pass" : "FAIL"}  ${result.model}: ${passed}/${turns} turns, started at thinking level ` +
        `${result.startingLevel || "-"}, ${tokens} tokens${result.error ? `; ${result.error}` : ""}`,
    );
  }
  console.log(`Report: ${reportPath}`);
  return failed ? 1 : 0;
}

async function main(argv: string[]) {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1);
  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      mock: { type: "boolean" },
      dir: { type: "string" },
      package: { type: "string" },
      port: { type: "string" },
      model: { type: "string", multiple: true },
      turns: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 2;
  }
  if (rest.length) throw new UsageError(`Unexpected argument: ${rest[0]}`);
  if (passthrough.length && command !== "pi") throw new UsageError(`"--" options are only for the pi command.`);
  switch (command) {
    case "models":
      return showModels(values);
    case "pi":
      return runPi(values, passthrough);
    case "mock":
      return runMock(values);
    case "verify":
      return verify();
    case "live":
      return runLive(values);
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      console.error(`Run "${CLI} --help" for usage.`);
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
  },
);
