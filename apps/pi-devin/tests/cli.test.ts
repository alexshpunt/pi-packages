import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { saveCredential } from "../src/cli/credentials.ts";
import { CHAT_METHOD, chatResponseCodec, unaryCodecs } from "../src/core/protocol/protobuf.ts";
import { encodeFrame } from "../src/core/protocol/transport.ts";
import { object, type JsonObject } from "../src/core/types.ts";
import { credential, finalFrames, modelResponse, requestBody, STATUS_METHOD, MODELS_METHOD, statusResponse } from "./helpers.ts";

const cwd = fileURLToPath(new URL("..", import.meta.url));
function run(directory: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["cli.ts", ...args], { cwd,
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, DEVIN_POC_STATE_DIR: directory }, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", reject); child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI image → real HTTP request, session resume in a new process, account change blocked", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "devin-cli-offline-"));
  const chats: JsonObject[] = [];
  const serverErrors: string[] = [];
  let base = "";
  let isDifferentUser = false;
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, base).pathname;
      if (path.startsWith("/v3/")) { res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
      const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
      const body = Buffer.concat(parts); const method = path.slice(1);
      expect(req.headers.authorization).toBe(`Basic ${credential.sessionToken}-${credential.sessionToken}`);
      const decoded = requestBody(method, { body: new Uint8Array(body) });
      if (method === CHAT_METHOD) {
        chats.push(decoded);
        res.writeHead(200, { "content-type": "application/connect+proto" });
        res.end(Buffer.concat([...finalFrames().map((frame) => encodeFrame(chatResponseCodec.encode(frame))), encodeFrame(Buffer.from("{}"), 2)]));
        return;
      }
      let response: JsonObject = {};
      if (method === STATUS_METHOD) {
        response = statusResponse(base);
        if (isDifferentUser) object(response.userStatus, "user").userId = "different-user";
      }
      if (method === MODELS_METHOD) {
        response = modelResponse();
        const configs = response.clientModelConfigs as JsonObject[];
        const high = structuredClone(configs[0]); high.modelUid = "swe-2-high"; high.label = "SWE-2 High";
        object(high.modelInfo, "modelInfo").modelUid = "swe-2-high"; configs.push(high);
      }
      res.writeHead(200, { "content-type": "application/proto" }).end(unaryCodecs(method).response.encode(response));
    } catch (error) { serverErrors.push(String(error)); res.writeHead(500).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); expect(address && typeof address !== "string").toBeTruthy(); if (!address || typeof address === "string") throw new Error("unreachable");
    base = `http://127.0.0.1:${address.port}`;
    await saveCredential({ ...credential, apiServerURL: base }, join(directory, "credentials.json"));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK9sAAAAASUVORK5CYII=", "base64");
    const image = join(directory, "fixture.png"); await writeFile(image, png);
    const output = join(directory, "report.json");
    const flags = ["chat", "--allow-model-calls", "--no-title", "--no-analytics", "--max-tokens", "5000", "--json"];
    const first = await run(directory, [...flags, "--model", "SWE 2 MEDIUM", "--image", image, "--output", output]);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const report = JSON.parse(await readFile(output, "utf8"));
    expect(report.imageCount).toBe(1); expect(report.modelCalls).toBe(1);
    expect(chats[0].chatModelUid).toBe("swe-2-medium");
    expect(Number(object(chats[0].configuration, "config").maxTokens)).toBe(5000);
    expect((chats[0].chatMessagePrompts as JsonObject[])[1].images).toStrictEqual([{ mimeType: "image/png", base64Data: png.toString("base64") }]);
    expect(first.stdout.includes(png.toString("base64"))).toBeFalsy();
    const second = await run(directory, [...flags, "--resume", report.sessionId, "--model", "swe-2-high", "--prompt", "continue"]);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    expect(chats.length).toBe(2);
    expect(chats[1].chatModelUid).toBe("swe-2-high");
    expect((chats[1].chatMessagePrompts as JsonObject[])[3].modelUid).toBe("swe-2-medium");
    expect(chats[1].cascadeId).toBe(chats[0].cascadeId);
    expect(chats[1].clientSessionId).toBe(chats[0].clientSessionId);
    expect(chats[1].executionId).not.toBe(chats[0].executionId);
    expect(object(chats[1].trajectoryReference, "trajectory").stepIndex).toBe(1);
    expect((chats[1].chatMessagePrompts as JsonObject[]).length).toBe(5);
    isDifferentUser = true;
    const rejected = await run(directory, [...flags, "--resume", report.sessionId, "--prompt", "do not send"]);
    expect(rejected.code).toBe(1);
    expect(rejected.stdout).toMatch(/different account/);
    expect(chats.length).toBe(2);
    expect(serverErrors).toStrictEqual([]);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI auth/permission/429 classification, initialization and analytics events, stream interruption and credential preservation", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "devin-cli-auth-offline-"));
  let failure = { method: STATUS_METHOD, status: 401, category: "authentication", command: "chat" };
  let paths: string[] = [];
  const serverErrors: string[] = [];
  let base = "";
  const server = createServer(async (req, res) => {
    try {
      const method = new URL(req.url!, base).pathname.slice(1); paths.push(method);
      for await (const _ of req) {}
      if (method === failure.method) {
        if (failure.status === 200) {
          res.writeHead(200, { "content-type": "application/connect+proto" }).end(Buffer.concat([
            encodeFrame(chatResponseCodec.encode({ deltaText: "partial" })),
            encodeFrame(Buffer.from('{"error":{"code":"unauthenticated","message":"offline invalid token"}}'), 2),
          ]));
        } else res.writeHead(failure.status, { "content-type": "application/json", "retry-after": "2" }).end("{}");
        return;
      }
      if (method.startsWith("v3/")) { res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
      const response = method === STATUS_METHOD ? statusResponse(base) : method === MODELS_METHOD ? modelResponse() : {};
      res.writeHead(200, { "content-type": "application/proto" }).end(unaryCodecs(method).response.encode(response));
    } catch (error) { serverErrors.push(String(error)); res.writeHead(500).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); expect(address && typeof address !== "string").toBeTruthy(); if (!address || typeof address === "string") throw new Error("unreachable");
    base = `http://127.0.0.1:${address.port}`;
    const file = join(directory, "credentials.json");
    await saveCredential({ ...credential, apiServerURL: base }, file);
    const original = await readFile(file, "utf8");
    const analyticsMethod = "exa.product_analytics_pb.ProductAnalyticsService/BatchRecordAnalyticsEvents";
    for (const current of [
      { method: STATUS_METHOD, status: 401, category: "authentication", command: "chat" },
      { method: STATUS_METHOD, status: 401, category: "authentication", command: "tool-roundtrip" },
      { method: "exa.api_server_pb.ApiServerService/GetAccountManagedPlugins", status: 401, category: "authentication", command: "chat" },
      { method: analyticsMethod, status: 401, category: "authentication", command: "chat" },
      { method: CHAT_METHOD, status: 401, category: "authentication", command: "chat" },
      { method: CHAT_METHOD, status: 200, category: "authentication", command: "chat" },
      { method: CHAT_METHOD, status: 403, category: "permission", command: "chat" },
      // The minimal check commands verify RPC error classification without upper-level inference recovery.
      { method: CHAT_METHOD, status: 429, category: "rate_limit", command: "tool-roundtrip" },
    ]) {
      failure = current; paths = [];
      const flags = [failure.command, "--allow-model-calls", "--json", "--timeout-ms", "5000"];
      if (failure.command === "chat") {
        flags.push("--prompt", "offline request", "--no-title");
        if (failure.method !== analyticsMethod) flags.push("--no-analytics");
      }
      const result = await run(directory, flags);
      expect(result.code, result.stdout + result.stderr).toBe(1);
      const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as JsonObject);
      const error = events.find((event) => event.event === "error");
      expect(error, result.stdout).toBeTruthy(); if (!error) throw new Error("unreachable");
      expect(error.category, result.stdout).toBe(failure.category);
      expect(error.requiresLogin).toBe(failure.category === "authentication" ? true : undefined);
      if (failure.category === "authentication") expect(String(error.message)).toMatch(/login/);
      if (failure.status === 429) expect(error.retryAfterMs).toBe(2000);
      expect(paths.at(-1)).toBe(failure.method);
      expect(paths.filter((path) => path === CHAT_METHOD).length).toBe(failure.method === CHAT_METHOD ? 1 : 0);
      expect(await readFile(file, "utf8")).toBe(original);
    }
    failure = { method: CHAT_METHOD, status: 429, category: "error", command: "chat" }; paths = [];
    const bounded = await run(directory, ["chat", "--allow-model-calls", "--json", "--prompt", "offline retry budget",
      "--no-title", "--no-analytics", "--max-model-calls", "1"]);
    expect(bounded.code).toBe(1);
    expect(bounded.stdout).toMatch(/inference request limit/);
    expect(paths.filter(path => path === CHAT_METHOD).length).toBe(1);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(serverErrors).toStrictEqual([]);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
