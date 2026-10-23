import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseCLIOptions } from "../src/cli/options.ts";
import { credential, requestBody, runSync, unaryResponse } from "./helpers.ts";

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
// Changes only the child CLI's platform. Automatic browser opening checks this value and refuses before spawning a process.
const LINUX_PLATFORM = "data:text/javascript,Object.defineProperty(process,%22platform%22,{value:%22linux%22})";

test("the CLI does not block login by OS name and never uses API key options or environment variables for auth", { timeout: 20000 }, async () => {
  expect(() => runSync(parseCLIOptions(["status", "--api-key", "cog_fake-service-key"]))).toThrow(expect.objectContaining({ code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }));
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-portable-"));
  const state = join(directory, "state");
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url !== "/auth/cli/token") { response.writeHead(500).end(); return; }
    expect(JSON.parse(Buffer.concat(chunks).toString()).code).toBe("portable-browser-code");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ token: "portable.fake.session" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); expect(address && typeof address !== "string").toBeTruthy(); if (!address || typeof address === "string") throw new Error("unreachable");
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
    expect(status.code).toBe(1);
    expect(status.events.map((event) => event.event)).toStrictEqual(["error"]);
    expect(status.events[0].message).toMatch(/Run login/);
    expect(requests).toBe(0);
    const login = await run(["login", "--webapp-url", origin, "--api-server-url", origin, "--login-api-url", origin], async (event) => {
      if (event.event !== "auth_url") return;
      const url = new URL(event.url), callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "portable-browser-code", state: url.searchParams.get("state")! }).toString();
      expect((await fetch(callback)).status).toBe(200);
    });
    expect(login.code, login.output).toBe(0);
    expect(login.events.map((event) => event.event)).toStrictEqual(["auth_url", "browser_open_failed", "logged_in"]);
    expect(login.events[1].message).toMatch(/URL yourself/);
    expect(requests).toBe(1);
    expect(JSON.parse(await readFile(join(state, "credentials.json"), "utf8")).sessionToken).toBe("devin-session-token$portable.fake.session");
    for (const result of [status, login]) expect(/cog_fake|sk-ws-01-fake|portable\.fake\.session/.test(result.output)).toBe(false);
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
        expect(body.code).toBe("cli-browser-code");
        expect(request.headers["connect-protocol-version"]).toBe(undefined);
        expect(request.headers.authorization).toBe(undefined);
        requests.push({ path: request.url, challenge: createHash("sha256").update(body.code_verifier).digest("base64url") });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ token: "cli.fake.session" }));
      } else {
        const method = request.url!.slice(1);
        expect(method.endsWith("/ExchangePKCEAuthorizationCode")).toBe(true);
        const body = requestBody(method, { body: bytes });
        expect(body.authorizationCode).toBe("cli-manual-code");
        requests.push({ path: request.url!, challenge: createHash("sha256").update(body.codeVerifier as string).digest("base64url") });
        const result = unaryResponse(method, { apiKey: credential.sessionToken });
        response.setHeader("content-type", "application/proto");
        response.end(Buffer.from(await result.arrayBuffer()));
      }
    } catch { response.writeHead(500).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); expect(address && typeof address !== "string").toBeTruthy(); if (!address || typeof address === "string") throw new Error("unreachable");
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
      expect(code, stderr).toBe(0);
      expect(stdout.includes("cli-browser-code") || stdout.includes("cli-manual-code")).toBe(false);
      return stdout;
    } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill(); }
  }
  try {
    let expectedChallenge = "";
    await run(["login", "--no-browser", "--webapp-url", origin, "--api-server-url", origin, "--login-api-url", origin], async (url) => {
      expectedChallenge = url.searchParams.get("code_challenge")!;
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "cli-browser-code", state: url.searchParams.get("state")! }).toString();
      expect((await fetch(callback)).status).toBe(200);
    });
    expect(requests).toStrictEqual([{ path: "/auth/cli/token", challenge: expectedChallenge }]);
    const file = join(state, "credentials.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.version).toBe(1); expect(saved.sessionToken).toBe("devin-session-token$cli.fake.session");
    expect(saved.apiServerURL).toBe(origin);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(state)).mode & 0o777).toBe(0o700);
    await run(["login", "--no-browser", "--force-manual-token-flow", "--webapp-url", origin, "--api-server-url", origin], async (url, send) => {
      expect(url.pathname).toBe("/devin/account/login");
      expectedChallenge = url.searchParams.get("code_challenge")!;
      send("wspkce$cli-manual-code");
    });
    expect(requests.length).toBe(2);
    expect(requests[1].challenge).toBe(expectedChallenge);
    expect(JSON.parse(await readFile(file, "utf8")).sessionToken).toBe(credential.sessionToken);
    await run(["logout"]);
    await expect(readFile(file)).rejects.toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(await readFile(piAuth, "utf8")).toBe(piBytes);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
