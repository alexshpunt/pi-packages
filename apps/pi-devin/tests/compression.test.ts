import { createServer, type IncomingHttpHeaders } from "node:http";
import { gzipSync, gunzipSync } from "node:zlib";
import { Effect, Stream } from "effect";
import { expect, test } from "vitest";
import { chatRequest, userMessage } from "../src/core/inference/request.ts";
import { streamChat } from "../src/core/inference/stream-chat.ts";
import { DevinError } from "../src/core/errors.ts";
import type { RequestAttempt } from "../src/core/protocol/connect-client.ts";
import { decodeFrames } from "../src/core/protocol/frames.ts";
import { CHAT_METHOD, chatRequestCodec } from "../src/core/protocol/protobuf.ts";
import { close, collect, connectClient, credential, encodeResponse, finalFrames, fingerprint, frameBytes, iterate, run, runSync } from "./helpers.ts";

function request() {
  return chatRequest({ metadata: { apiKey: credential.sessionToken, f: runSync(fingerprint().create) }, model: "swe-2-medium",
    messages: [userMessage("compress ".repeat(5000))], systemPrompt: "system", maxTokens: 128,
    cascadeId: "cascade", trajectoryId: "trajectory", clientSessionId: "clear-otter", executionId: "execution" });
}

test("real HTTP gzip + Connect gzip responses and an identical uncompressed resend on 415", async () => {
  const received: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const attempts: RequestAttempt[] = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    received.push({ headers: req.headers, body: Buffer.concat(parts) });
    if (received.length === 1) { res.writeHead(415, { "content-type": "application/json" }).end('{"code":"invalid_argument"}'); return; }
    const frames = finalFrames("compressed reply").map((frame) => frameBytes(gzipSync(encodeResponse(frame)), 1));
    frames.push(frameBytes(Buffer.from("{}"), 2));
    res.writeHead(200, { "content-type": "application/connect+proto", "content-encoding": "gzip", "connect-content-encoding": "gzip" });
    res.end(gzipSync(Buffer.concat(frames)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); expect(address && typeof address !== "string").toBeTruthy(); if (!address || typeof address === "string") throw new Error("unreachable");
    const client = connectClient({ baseURL: `http://127.0.0.1:${address.port}`, token: credential.sessionToken,
      onRequest: (attempt) => Effect.sync(() => { attempts.push(attempt); }) });
    const result = await run(streamChat(client, request()));
    expect(result.message.prompt).toBe("compressed reply");
    expect(result.lastUsageFrameIndex! > result.stopFrameIndex!).toBeTruthy();
    expect(attempts.map((attempt) => [attempt.attempt, attempt.isCompressed])).toStrictEqual([[1, true], [2, false]]);
    expect(received[0].body[0]).toBe(1); expect(received[1].body[0]).toBe(0);
    expect(received[0].headers["connect-content-encoding"]).toBe("gzip");
    expect(received[1].headers["connect-content-encoding"]).toBe(undefined);
    for (const sent of received) expect(Number(sent.headers["content-length"])).toBe(sent.body.length);
    expect(received[0].headers["sentry-trace"]).toBe(received[1].headers["sentry-trace"]);
    const first = gunzipSync(received[0].body.subarray(5));
    expect(first).toStrictEqual(received[1].body.subarray(5));
    const decoded = runSync(chatRequestCodec.decode(first));
    expect(decoded.clientSessionId).toBe("clear-otter");
    expect(decoded.executionId).toBe("execution");
    close(client);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("408/415/500/502/503/504 resend only compressed requests, once, with the same body", async () => {
  for (const status of [408, 415, 500, 502, 503, 504]) {
    const attempts: { bytes: Buffer; headers: Headers }[] = [];
    const client = connectClient({ baseURL: credential.apiServerURL, fetch: async (_url, init) => {
      attempts.push({ bytes: Buffer.from(init!.body as Uint8Array), headers: new Headers(init!.headers) });
      if (attempts.length === 1) return Response.json({}, { status });
      return new Response(new Uint8Array(Buffer.concat([
        ...finalFrames().map((frame) => frameBytes(encodeResponse(frame))), frameBytes(Buffer.from("{}"), 2),
      ])), { headers: { "content-type": "application/connect+proto" } });
    } });
    await run(streamChat(client, request()));
    expect(attempts.length).toBe(2);
    expect(attempts[0].bytes[0]).toBe(1); expect(attempts[1].bytes[0]).toBe(0);
    expect(gunzipSync(attempts[0].bytes.subarray(5)).equals(attempts[1].bytes.subarray(5)), "the fallback body must not change.").toBeTruthy();
    expect(attempts[0].headers.get("sentry-trace")).toBe(attempts[1].headers.get("sentry-trace"));
    close(client);
  }
});

test("native observations and both sides of the static 8192-byte boundary are checked in the final frame", async () => {
  for (const [payloadBytes, expectedFlag] of [[8179, 0], [8191, 0], [8192, 1], [8193, 1], [8286, 1]]) {
    // The decision must use the final protobuf's UTF-8 byte count, not the string length (€ is 3 bytes in UTF-8).
    const body = { prompt: "€".repeat(2000) + "x".repeat(payloadBytes - 6003) };
    expect(runSync(chatRequestCodec.encode(body)).length).toBe(payloadBytes);
    const client = connectClient({ baseURL: credential.apiServerURL, fetch: async (_url, init) => {
      const bytes = Buffer.from(init!.body as Uint8Array);
      expect(bytes[0]).toBe(expectedFlag);
      expect(bytes.readUInt32BE(1)).toBe(bytes.length - 5);
      const headers = new Headers(init!.headers);
      expect(headers.get("connect-content-encoding")).toBe(expectedFlag ? "gzip" : null);
      expect(Number(headers.get("content-length"))).toBe(bytes.length);
      expect(expectedFlag ? gunzipSync(bytes.subarray(5)) : bytes.subarray(5)).toStrictEqual(Buffer.from(runSync(chatRequestCodec.encode(body))));
      return new Response(new Uint8Array(frameBytes(Buffer.from("{}"), 2)), { headers: { "content-type": "application/connect+proto" } });
    } });
    await collect(client.stream(CHAT_METHOD, body));
  }
});

test("the 415 resend happens at most once and is not sent when the request budget refuses", async () => {
  let calls = 0;
  const client = connectClient({ baseURL: credential.apiServerURL, fetch: async () => { calls++; return Response.json({}, { status: 415 }); } });
  await expect(collect(client.stream(CHAT_METHOD, request()))).rejects.toThrow(/http_415/);
  expect(calls).toBe(2);
  calls = 0;
  const budgeted = connectClient({ baseURL: credential.apiServerURL,
    onRequest: (attempt) => attempt.attempt === 2 ? Effect.fail(new DevinError({ message: "budget exhausted" })) : Effect.void,
    fetch: async () => { calls++; return Response.json({}, { status: 415 }); },
  });
  await expect(collect(budgeted.stream(CHAT_METHOD, request()))).rejects.toThrow(/budget exhausted/);
  expect(calls).toBe(1);
});

test("rejects oversized decompression and invalid gzip", async () => {
  const decode = (payload: Uint8Array) => collect(decodeFrames(Stream.fromIterable([frameBytes(payload, 1), frameBytes(Buffer.from("{}"), 2)]), { compression: "gzip" }));
  await expect(decode(Buffer.from("invalid gzip"))).rejects.toThrow();
  await expect(decode(gzipSync(Buffer.alloc(9 * 1024 * 1024)))).rejects.toThrow();
});

test("the RPC timeout applies to the real connection even after the response starts", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/connect+proto" });
    res.write(frameBytes(encodeResponse({ deltaText: "partial" })));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); expect(address && typeof address !== "string").toBeTruthy(); if (!address || typeof address === "string") throw new Error("unreachable");
    const client = connectClient({ baseURL: `http://127.0.0.1:${address.port}`, timeoutMs: 100 });
    const stream = iterate(client.stream(CHAT_METHOD, {}));
    expect((await stream.next()).value?.data.deltaText).toBe("partial");
    await expect(stream.next()).rejects.toThrow(expect.toSatisfy((error: Error) => error.name === "TimeoutError"));
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
