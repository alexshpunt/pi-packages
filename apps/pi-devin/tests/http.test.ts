import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHTTPServer } from "node:http";
import { createServer as createHTTPSServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import type { TLSSocket } from "node:tls";
import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";
import { isAuthenticationError, RPCError } from "../src/core/errors.ts";
import { fromHttpClientError, makeNodeHttpClient } from "../src/core/protocol/http.ts";
import { unaryCodecs } from "../src/core/protocol/protobuf.ts";
import { close, connectClient, run, runSync, STATUS_METHOD, statusResponse } from "./helpers.ts";

async function localCertificate(t: TestContext): Promise<{ key: Buffer; cert: Buffer }> {
  const directory = await mkdtemp(join(tmpdir(), "devin-poc-tls-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "openssl.cnf");
  await writeFile(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n", { mode: 0o600 });
  // One-off certificate for this test only. The OS trust store is not modified.
  execFileSync(process.platform === "darwin" ? "/usr/bin/openssl" : "openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-config", config,
    "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
  ], { timeout: 10_000, stdio: "pipe", env: { PATH: process.env.PATH, HOME: directory } });
  return { key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) };
}

test("real TLS certificate and host verification, SNI/ALPN HTTP/1.1, sequential connection reuse and close", { timeout: 15_000 }, async (t) => {
  const certificate = await localCertificate(t);
  const records: { version: string; alpn: string | false | null; protocol: string | null; servername: string | false | undefined; socket: TLSSocket; auth?: string; cookie?: string }[] = [];
  const server = createHTTPSServer({ ...certificate, minVersion: "TLSv1.2", ALPNProtocols: ["h2", "http/1.1"] }, async (req, res) => {
    for await (const _ of req) {}
    const socket = req.socket as TLSSocket & { servername?: string | false };
    records.push({ version: req.httpVersion, alpn: socket.alpnProtocol, protocol: socket.getProtocol(), servername: socket.servername,
      socket, auth: req.headers.authorization, cookie: req.headers.cookie });
    if (req.url === "/v3/self") res.writeHead(200, { "content-type": "application/json", "set-cookie": "never-send-this=1" }).end("{}");
    else res.writeHead(200, { "content-type": "application/proto" }).end(runSync(Effect.flatMap(unaryCodecs(STATUS_METHOD), (codecs) => codecs.response.encode(statusResponse()))));
  });
  server.keepAliveTimeout = 10_000;
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); expect(address && typeof address !== "string").toBeTruthy(); if (!address || typeof address === "string") throw new Error("unreachable");
  const base = `https://localhost:${address.port}`;
  const trusted = connectClient({ baseURL: base, token: "offline-tls-token", http: { ca: certificate.cert }, timeoutMs: 5000 });
  const untrusted = connectClient({ baseURL: base, timeoutMs: 5000 });
  const wrongHost = connectClient({ baseURL: `https://127.0.0.1:${address.port}`, http: { ca: certificate.cert }, timeoutMs: 5000 });
  t.onTestFinished(() => { close(trusted); close(untrusted); close(wrongHost); });
  await expect(run(untrusted.unary(STATUS_METHOD, {}))).rejects.toThrow(/self.signed|certificate/i);
  await expect(run(wrongHost.unary(STATUS_METHOD, {}))).rejects.toThrow(/Hostname|IP|altname/i);
  expect(records.length).toBe(0);
  await run(trusted.getJSON(base, "/v3/self"));
  await run(trusted.unary(STATUS_METHOD, {}));
  expect(records.length).toBe(2);
  expect(records[0].socket).toBe(records[1].socket);
  expect(records.map((record) => record.auth)).toStrictEqual(["Bearer offline-tls-token", "Basic offline-tls-token-offline-tls-token"]);
  for (const record of records) {
    expect(record.version).toBe("1.1");
    expect(record.alpn).toBe("http/1.1");
    expect(["TLSv1.2", "TLSv1.3"].includes(record.protocol!)).toBeTruthy();
    expect(record.servername).toBe("localhost");
    expect(record.cookie).toBe(undefined);
  }
  const closed = new Promise<void>((resolve) => records[0].socket.once("close", resolve));
  close(trusted);
  await closed;
  await expect(run(trusted.unary(STATUS_METHOD, {}))).rejects.toThrow(/closed/);
  expect(records.length).toBe(2);
});

test("RPC credentials are not forwarded on redirects", async (t) => {
  const paths: string[] = [];
  const server = createHTTPServer((req, res) => {
    paths.push(req.url!);
    res.writeHead(302, { location: "/redirect-target" }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); expect(address && typeof address !== "string").toBeTruthy(); if (!address || typeof address === "string") throw new Error("unreachable");
  const client = connectClient({ baseURL: `http://127.0.0.1:${address.port}`, token: "offline-redirect-token" });
  t.onTestFinished(() => close(client));
  await expect(run(client.unary(STATUS_METHOD, {}))).rejects.toThrow(expect.toSatisfy((error: unknown) => error instanceof RPCError && error.httpStatus === 302));
  expect(paths).toStrictEqual([`/${STATUS_METHOD}`]);
});

test("unsupported error body compression does not hide 401/429 statuses", async (t) => {
  let status = 401;
  const server = createHTTPServer((_req, res) => res.writeHead(status, { "content-encoding": "br", "content-type": "application/proto", "retry-after": "3" }).end("raw"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); expect(address && typeof address !== "string").toBeTruthy(); if (!address || typeof address === "string") throw new Error("unreachable");
  for (const value of [401, 429, 200]) {
    status = value;
    const client = connectClient({ baseURL: `http://127.0.0.1:${address.port}`, token: "offline-token" });
    t.onTestFinished(() => close(client));
    await expect(run(client.unary(STATUS_METHOD, {}))).rejects.toThrow(expect.toSatisfy((error: unknown) => {
      if (status === 401) expect(isAuthenticationError(error)).toBeTruthy();
      else if (status === 429) { expect(error instanceof RPCError).toBeTruthy(); if (!(error instanceof RPCError)) throw new Error("unreachable"); expect(error.kind).toBe("rate_limit"); expect(error.retryAfterMs).toBe(3000); }
      else expect((error as Error).message).toMatch(/response compression/);
      return true;
    }));
    expect(runSync(client.isAuthenticationInvalid)).toBe(status === 401);
  }
});

test("HTTP upgrade is rejected and its socket is closed", async (t) => {
  const server = createHTTPServer();
  server.on("upgrade", (_req, socket) => { socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); expect(address && typeof address !== "string").toBeTruthy(); if (!address || typeof address === "string") throw new Error("unreachable");
  // The transport does not add Connection itself, so the server answers a plain request with 101.
  server.on("request", (_req, res) => res.writeHead(101, { connection: "upgrade", upgrade: "websocket" }).end());
  const request = Effect.scoped(Effect.flatMap(makeNodeHttpClient(), (http) => http.execute(HttpClientRequest.get(`http://127.0.0.1:${address.port}/`)))).pipe(Effect.mapError(fromHttpClientError));
  await expect(run(request)).rejects.toThrow(/upgrade/);
});
