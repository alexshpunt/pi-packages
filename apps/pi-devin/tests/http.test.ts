import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHTTPServer } from "node:http";
import { createServer as createHTTPSServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { TLSSocket } from "node:tls";
import { createHTTPTransport } from "../src/core/protocol/http.ts";
import { unaryCodecs } from "../src/core/protocol/protobuf.ts";
import { ConnectClient, isAuthenticationError, RPCError } from "../src/core/protocol/transport.ts";
import { STATUS_METHOD, statusResponse } from "./helpers.ts";

async function localCertificate(t: TestContext): Promise<{ key: Buffer; cert: Buffer }> {
  const directory = await mkdtemp(join(tmpdir(), "devin-poc-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
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
    else res.writeHead(200, { "content-type": "application/proto" }).end(unaryCodecs(STATUS_METHOD).response.encode(statusResponse()));
  });
  server.keepAliveTimeout = 10_000;
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `https://localhost:${address.port}`;
  const trusted = new ConnectClient({ baseURL: base, token: "offline-tls-token", http: { ca: certificate.cert }, timeoutMs: 5000 });
  const untrusted = new ConnectClient({ baseURL: base, timeoutMs: 5000 });
  const wrongHost = new ConnectClient({ baseURL: `https://127.0.0.1:${address.port}`, http: { ca: certificate.cert }, timeoutMs: 5000 });
  t.after(() => { trusted.close(); untrusted.close(); wrongHost.close(); });
  await assert.rejects(untrusted.unary(STATUS_METHOD, {}), /self.signed|certificate/i);
  await assert.rejects(wrongHost.unary(STATUS_METHOD, {}), /Hostname|IP|altname/i);
  assert.equal(records.length, 0);
  await trusted.getJSON(base, "/v3/self");
  await trusted.unary(STATUS_METHOD, {});
  assert.equal(records.length, 2);
  assert.equal(records[0].socket, records[1].socket);
  assert.deepEqual(records.map((record) => record.auth), ["Bearer offline-tls-token", "Basic offline-tls-token-offline-tls-token"]);
  for (const record of records) {
    assert.equal(record.version, "1.1");
    assert.equal(record.alpn, "http/1.1");
    assert.ok(["TLSv1.2", "TLSv1.3"].includes(record.protocol!));
    assert.equal(record.servername, "localhost");
    assert.equal(record.cookie, undefined);
  }
  const closed = new Promise<void>((resolve) => records[0].socket.once("close", resolve));
  trusted.close();
  await closed;
  await assert.rejects(trusted.unary(STATUS_METHOD, {}), /closed/);
  assert.equal(records.length, 2);
});

test("RPC credentials are not forwarded on redirects", async (t) => {
  const paths: string[] = [];
  const server = createHTTPServer((req, res) => {
    paths.push(req.url!);
    res.writeHead(302, { location: "/redirect-target" }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = new ConnectClient({ baseURL: `http://127.0.0.1:${address.port}`, token: "offline-redirect-token" });
  t.after(() => client.close());
  await assert.rejects(client.unary(STATUS_METHOD, {}), (error: unknown) => error instanceof RPCError && error.httpStatus === 302);
  assert.deepEqual(paths, [`/${STATUS_METHOD}`]);
});

test("unsupported error body compression does not hide 401/429 statuses", async (t) => {
  let status = 401;
  const server = createHTTPServer((_req, res) => res.writeHead(status, { "content-encoding": "br", "content-type": "application/proto", "retry-after": "3" }).end("raw"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  for (const value of [401, 429, 200]) {
    status = value;
    const client = new ConnectClient({ baseURL: `http://127.0.0.1:${address.port}`, token: "offline-token" });
    t.after(() => client.close());
    await assert.rejects(client.unary(STATUS_METHOD, {}), (error: unknown) => {
      if (status === 401) assert.ok(isAuthenticationError(error));
      else if (status === 429) { assert.ok(error instanceof RPCError); assert.equal(error.kind, "rate_limit"); assert.equal(error.retryAfterMs, 3000); }
      else assert.match((error as Error).message, /response compression/);
      return true;
    });
    assert.equal(client.isAuthenticationInvalid, status === 401);
  }
});

test("HTTP upgrade is rejected and its socket is closed", async (t) => {
  const server = createHTTPServer();
  server.on("upgrade", (_req, socket) => { socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const http = createHTTPTransport();
  t.after(() => http.close());
  // requestHTTP does not add Connection itself, so the server answers a plain request with 101.
  server.on("request", (_req, res) => res.writeHead(101, { connection: "upgrade", upgrade: "websocket" }).end());
  await assert.rejects(http.fetch(`http://127.0.0.1:${address.port}/`, { method: "GET", redirect: "error" }), /upgrade/);
});
