import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseCLIOptions } from "../src/cli/options.ts";
import { credential, requestBody, unaryResponse } from "./helpers.ts";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
// Changes only the child CLI's platform. Automatic browser opening checks this value and refuses before spawning a process.
const LINUX_PLATFORM = "data:text/javascript,Object.defineProperty(process,%22platform%22,{value:%22linux%22})";

test("the CLI does not block login by OS name and never uses API key options or environment variables for auth", { timeout: 20000 }, async () => {
  assert.throws(() => parseCLIOptions(["status", "--api-key", "cog_fake-service-key"]), { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" });
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-portable-"));
  const state = join(directory, "state");
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url !== "/auth/cli/token") { response.writeHead(500).end(); return; }
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).code, "portable-browser-code");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ token: "portable.fake.session" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const env = { HOME: join(directory, "home"), DEVIN_POC_STATE_DIR: state, TMPDIR: directory, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    DEVIN_API_KEY: "cog_fake-service-key", WINDSURF_API_KEY: "sk-ws-01-fake-key" };
  async function run(args: string[], onEvent: (event: Record<string, string>) => Promise<void> = async () => {}) {
    const child = spawn(process.execPath, ["--import", LINUX_PLATFORM, cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", lineBuffer = "";
    const events: Record<string, string>[] = [], handlers: Promise<void>[] = [];
    child.stdout.on("data", (chunk) => {
      output += chunk; lineBuffer += chunk;
      const lines = lineBuffer.split("\n"); lineBuffer = lines.pop()!;
      for (const line of lines) if (line.trim()) {
        const event = JSON.parse(line); events.push(event);
        const pending = onEvent(event); void pending.catch(() => child.kill()); handlers.push(pending);
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timeout = setTimeout(() => child.kill(), 10000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      await Promise.all(handlers);
      return { code, output, events };
    } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill(); }
  }
  try {
    const status = await run(["status"]);
    assert.equal(status.code, 1);
    assert.deepEqual(status.events.map((event) => event.event), ["error"]);
    assert.match(status.events[0].message, /Run login/);
    assert.equal(requests, 0);
    const login = await run(["login", "--webapp-url", origin, "--api-server-url", origin, "--login-api-url", origin], async (event) => {
      if (event.event !== "auth_url") return;
      const url = new URL(event.url), callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "portable-browser-code", state: url.searchParams.get("state")! }).toString();
      assert.equal((await fetch(callback)).status, 200);
    });
    assert.equal(login.code, 0, login.output);
    assert.deepEqual(login.events.map((event) => event.event), ["auth_url", "browser_open_failed", "logged_in"]);
    assert.match(login.events[1].message, /URL yourself/);
    assert.equal(requests, 1);
    assert.equal(JSON.parse(await readFile(join(state, "credentials.json"), "utf8")).sessionToken, "devin-session-token$portable.fake.session");
    for (const result of [status, login]) assert.equal(/cog_fake|sk-ws-01-fake|portable\.fake\.session/.test(result.output), false);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI default and manual login use the shared exchange and a separate store, and logout keeps the Pi files", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-login-"));
  const home = join(directory, "home"), state = join(directory, "state"), piAuth = join(home, ".pi", "agent", "auth.json");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  const piBytes = JSON.stringify({ fakeProvider: { type: "oauth", access: "unrelated-fake-pi-token", refresh: "", expires: 0 } });
  await writeFile(piAuth, piBytes);
  const requests: { path: string; challenge: string }[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (request.url === "/auth/cli/token") {
        const body = JSON.parse(bytes.toString());
        assert.equal(body.code, "cli-browser-code");
        assert.equal(request.headers["connect-protocol-version"], undefined);
        assert.equal(request.headers.authorization, undefined);
        requests.push({ path: request.url, challenge: createHash("sha256").update(body.code_verifier).digest("base64url") });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ token: "cli.fake.session" }));
      } else {
        const method = request.url!.slice(1);
        assert.equal(method.endsWith("/ExchangePKCEAuthorizationCode"), true);
        const body = requestBody(method, { body: bytes });
        assert.equal(body.authorizationCode, "cli-manual-code");
        requests.push({ path: request.url!, challenge: createHash("sha256").update(body.codeVerifier as string).digest("base64url") });
        const result = unaryResponse(method, { apiKey: credential.sessionToken });
        response.setHeader("content-type", "application/proto");
        response.end(Buffer.from(await result.arrayBuffer()));
      }
    } catch { response.writeHead(500).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const env = { HOME: home, DEVIN_POC_STATE_DIR: state, TMPDIR: directory, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  async function run(args: string[], handleURL?: (url: URL, send: (value: string) => void) => Promise<void>) {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", lineBuffer = "";
    const callbacks: Promise<void>[] = [];
    child.stdout.on("data", (chunk) => {
      stdout += chunk; lineBuffer += chunk;
      const lines = lineBuffer.split("\n"); lineBuffer = lines.pop()!;
      for (const line of lines) if (line.trim()) {
        const event = JSON.parse(line);
        if (event.event === "auth_url" && handleURL) {
          const pending = handleURL(new URL(event.url), (value) => child.stdin.end(value + "\n"));
          void pending.catch(() => child.kill()); callbacks.push(pending);
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill(), 10000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      await Promise.all(callbacks);
      assert.equal(code, 0, stderr);
      assert.equal(stdout.includes("cli-browser-code") || stdout.includes("cli-manual-code"), false);
      return stdout;
    } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill(); }
  }
  try {
    let expectedChallenge = "";
    await run(["login", "--no-browser", "--webapp-url", origin, "--api-server-url", origin, "--login-api-url", origin], async (url) => {
      expectedChallenge = url.searchParams.get("code_challenge")!;
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "cli-browser-code", state: url.searchParams.get("state")! }).toString();
      assert.equal((await fetch(callback)).status, 200);
    });
    assert.deepEqual(requests, [{ path: "/auth/cli/token", challenge: expectedChallenge }]);
    const file = join(state, "credentials.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.version, 1); assert.equal(saved.sessionToken, "devin-session-token$cli.fake.session");
    assert.equal(saved.apiServerURL, origin);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(state)).mode & 0o777, 0o700);
    await run(["login", "--no-browser", "--force-manual-token-flow", "--webapp-url", origin, "--api-server-url", origin], async (url, send) => {
      assert.equal(url.pathname, "/devin/account/login");
      expectedChallenge = url.searchParams.get("code_challenge")!;
      send("wspkce$cli-manual-code");
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].challenge, expectedChallenge);
    assert.equal(JSON.parse(await readFile(file, "utf8")).sessionToken, credential.sessionToken);
    await run(["logout"]);
    await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.equal(await readFile(piAuth, "utf8"), piBytes);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
