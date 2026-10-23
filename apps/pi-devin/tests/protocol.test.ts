import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { Stream } from "effect";
import { expect, test } from "vitest";
import { ChatAccumulator } from "../src/core/inference/accumulator.ts";
import { chatRequest } from "../src/core/inference/request.ts";
import { decodeFrames } from "../src/core/protocol/frames.ts";
import { CHAT_METHOD, chatRequestCodec, chatResponseCodec } from "../src/core/protocol/protobuf.ts";
import { safeError } from "../src/core/redaction.ts";
import type { JsonObject } from "../src/core/types.ts";
import { object } from "../src/core/validation.ts";
import { abortStream, collect, connectClient, frameBytes, iterate, run, runSync, STATUS_METHOD } from "./helpers.ts";

function encodeFrame(value: JsonObject, flags = 0): Buffer {
  return frameBytes(flags & 2 ? Buffer.from(JSON.stringify(value)) : runSync(chatResponseCodec.encode(value)), flags);
}

function capturedJSON(text: string): JsonObject {
  return JSON.parse(text, (_key, value) => typeof value === "string"
    ? value.replace(/^Exa[A-Za-z0-9]+_[A-Za-z0-9]+_([A-Z][A-Z0-9_]+)$/, "$1") : value);
}

function chunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) parts.push(bytes.subarray(offset, offset + size));
  return parts;
}

const decode = (bytes: Uint8Array, size = bytes.length) => collect(decodeFrames(Stream.fromIterable(chunks(bytes, size))));

test("Connect frames: 1-byte boundaries, UTF-8 and consecutive frames", async () => {
  expect([...runSync(chatRequestCodec.encode({ prompt: "A" }))]).toStrictEqual([0x12, 0x01, 0x41]);
  expect(() => runSync(chatRequestCodec.encode({ chatModelUid: "test", unknownField: true }))).toThrow(/Field not in the protobuf schema/);
  expect(() => runSync(chatRequestCodec.encode({ requestType: "UNKNOWN_ENUM" }))).toThrow(/Unknown protobuf enum/);
  const bytes = Buffer.concat([encodeFrame({ deltaText: "héllo wörld🙂" }), encodeFrame({}, 2)]);
  for (const size of [1, 2, 4, 5, 7, bytes.length]) {
    const result = await decode(bytes, size);
    expect(result[0].data.deltaText).toBe("héllo wörld🙂");
    expect(result[1].isEnd).toBe(true);
  }
});

test("Connect frames: truncation, missing end, compression, oversize and data after the end", async () => {
  const data = encodeFrame({ deltaText: "hello" });
  await expect(decode(data.subarray(0, data.length - 1))).rejects.toThrow(/incomplete/);
  await expect(decode(data)).rejects.toThrow(/without EndStream/);
  await expect(decode(encodeFrame({}, 1))).rejects.toThrow(/compressed frame/);
  await expect(decode(encodeFrame({}, 4))).rejects.toThrow(/flags/);
  await expect(decode(Buffer.concat([encodeFrame({}, 2), data]))).rejects.toThrow(/follows EndStream/);
  const header = Buffer.alloc(5); header.writeUInt32BE(9 * 1024 * 1024, 1);
  await expect(decode(header)).rejects.toThrow(/8 MiB/);
});

test("keeps tool arguments without an ID and usage after stopReason", () => {
  const acc = new ChatAccumulator();
  runSync(acc.accept({ deltaToolCalls: [{ id: "call-1", name: "add" }], deltaThinking: "calculating" }));
  runSync(acc.accept({ deltaToolCalls: [{ argumentsJson: '{"a":17,' }] }));
  runSync(acc.accept({ deltaToolCalls: [{ argumentsJson: '"b":25}' }] }));
  runSync(acc.accept({ stopReason: "STOP_REASON_FUNCTION_CALL" }));
  runSync(acc.accept({ usage: { inputTokens: "235", outputTokens: "35", cacheReadTokens: "11961" } }));
  runSync(acc.accept({ usage: { modelUid: "test" } }));
  runSync(acc.accept({}, true));
  const result = runSync(acc.finish);
  expect(result.usage.totalTokens).toBe(12231);
  expect(result.lastUsageFrameIndex).toBe(5);
  expect(result.idlessToolDeltaCount).toBe(2);
  expect(JSON.parse(result.message.toolCalls![0].argumentsJson)).toStrictEqual({ a: 17, b: 25 });
  expect(result.message.thinking).toBe("calculating");
});

test("ambiguous tool deltas and invalid arguments never become executable calls", () => {
  const acc = new ChatAccumulator();
  expect(() => runSync(acc.accept({ deltaToolCalls: [{ argumentsJson: "{}" }] }))).toThrow(/Cannot attach/);
  const parallel = new ChatAccumulator();
  runSync(parallel.accept({ deltaToolCalls: [{ id: "a", name: "add" }, { id: "b", name: "add" }] }));
  expect(() => runSync(parallel.accept({ deltaToolCalls: [{ argumentsJson: "{}" }] }))).toThrow(/Cannot attach/);
  for (const argumentsJson of ["[1,2]", '{"unfinished":']) {
    const invalid = new ChatAccumulator();
    runSync(invalid.accept({ deltaToolCalls: [{ id: "a", name: "add", argumentsJson }], stopReason: "STOP_REASON_FUNCTION_CALL" }));
    runSync(invalid.accept({}, true));
    expect(() => runSync(invalid.finish)).toThrow(/JSON/);
  }
});

test("replay of 7 preserved captures: protobuf request/response serialization and field preservation", async () => {
  const separator = "[----------------------next message----------------------]";
  for (const sample of ["01", "02", "03", "04", "05", "06", "07-image"]) {
    const path = new URL(`./fixtures/captured-samples/GetChatMessage/${sample}/response.txt`, import.meta.url);
    const text = await readFile(path, "utf8");
    const request = capturedJSON(await readFile(new URL("request.txt", path), "utf8"));
    const decodedRequest = runSync(chatRequestCodec.decode(runSync(chatRequestCodec.encode(request))));
    expect(decodedRequest.chatModelUid, sample).toBe(request.chatModelUid);
    expect(decodedRequest.prompt, sample).toBe(request.prompt);
    expect(runSync(object(decodedRequest.metadata, "metadata")).f, sample).toBe(runSync(object(request.metadata, "metadata")).f);
    expect(decodedRequest.tools, sample).toStrictEqual(request.tools);
    const acc = new ChatAccumulator();
    for (const part of text.split(separator).filter((value) => value.trim())) {
      const frame = capturedJSON(part);
      runSync(acc.accept(runSync(chatResponseCodec.decode(runSync(chatResponseCodec.encode(frame))))));
    }
    // The captures are protobuf converted to text, so the real EndStream bytes were not preserved.
    runSync(acc.accept({}, true));
    const result = runSync(acc.finish);
    expect(result.usageReported, sample).toBe(true);
    expect(result.lastUsageFrameIndex! > result.stopFrameIndex!, sample).toBeTruthy();
    if (sample === "04") {
      expect(result.message.toolCalls?.length).toBe(1);
      expect(JSON.parse(result.message.toolCalls![0].argumentsJson)).toStrictEqual({ command: "ls -la ~/Desktop" });
      expect(result.usage.totalTokens).toBe(12231);
    }
  }
});

test("final protobuf requests, headers and cancellation are checked with an injected transport and real loopback", async () => {
  const controller = new AbortController();
  const request = chatRequest({
    metadata: { apiKey: "mock-secret" }, model: "swe-2-medium", messages: [],
    systemPrompt: "system", maxTokens: 128, cascadeId: "cascade", trajectoryId: "trajectory", executionId: "execution",
  });
  let requests = 0;
  let firstTrace = "";
  let fetchSignal: AbortSignal | undefined;
  const client = connectClient({
    baseURL: "https://example.invalid", token: "mock-secret",
    fetch: async (_url, init) => {
      requests++;
      expect(new Headers(init?.headers).get("Authorization")).toBe("Basic mock-secret-mock-secret");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeTruthy(); if (!init?.signal) throw new Error("unreachable");
      expect(init.signal).not.toBe(controller.signal);
      fetchSignal = init.signal;
      const bytes = Buffer.from(init.body as Uint8Array);
      const body = runSync(chatRequestCodec.decode(bytes.subarray(5)));
      expect(Number(runSync(object(body.configuration, "configuration")).maxTokens)).toBe(128);
      expect(runSync(object(body.metadata, "metadata")).apiKey).toBe("mock-secret");
      firstTrace = new Headers(init?.headers).get("sentry-trace")!;
      expect(firstTrace).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-0$/);
      controller.abort();
      // A response that never arrives: the caller's cancellation must still end the request.
      return new Promise<Response>(() => {});
    },
  });
  await expect(collect(client.stream(CHAT_METHOD, request), controller.signal)).rejects.toThrow();
  expect(requests).toBe(1);
  expect(fetchSignal?.aborted).toBe(true);

  let observe!: (value: { headers: IncomingHttpHeaders; body: Buffer }) => void;
  const observed = new Promise<{ headers: IncomingHttpHeaders; body: Buffer }>((resolve) => { observe = resolve; });
  const server = createServer(async (incoming, response) => {
    const parts: Buffer[] = [];
    for await (const chunk of incoming) parts.push(Buffer.from(chunk));
    observe({ headers: incoming.headers, body: Buffer.concat(parts) });
    response.writeHead(200, { "content-type": "application/connect+proto" });
    response.write(encodeFrame({ deltaText: "streaming" }));
    // Checks cancellation while reading a response that never ends.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    expect(address && typeof address !== "string").toBeTruthy(); if (!address || typeof address === "string") throw new Error("unreachable");
    const local = connectClient({ baseURL: `http://127.0.0.1:${address.port}`, token: "mock-secret", timeoutMs: 2000 });
    const cancellation = new AbortController();
    const stream = iterate(local.stream(CHAT_METHOD, request).pipe(abortStream(cancellation.signal)));
    expect((await stream.next()).value?.data.deltaText).toBe("streaming");
    const sent = await observed;
    expect(Object.keys(sent.headers).sort()).toStrictEqual([
      "accept", "accept-encoding", "authorization", "connect-protocol-version", "content-length", "content-type", "host", "sentry-trace",
    ]);
    expect(sent.headers["content-type"]).toBe("application/connect+proto");
    expect(Number(sent.headers["content-length"])).toBe(sent.body.byteLength);
    expect(sent.headers.authorization).toBe("Basic mock-secret-mock-secret");
    expect(String(sent.headers["sentry-trace"])).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-0$/);
    expect(sent.headers["sentry-trace"]).not.toBe(firstTrace);
    const decoded = runSync(chatRequestCodec.decode(sent.body.subarray(5)));
    expect(Number(runSync(object(decoded.configuration, "configuration")).maxTokens)).toBe(128);
    expect(runSync(object(decoded.metadata, "metadata")).apiKey).toBe("mock-secret");
    expect(runSync(object(decoded.trajectoryReference, "trajectory")).trajectoryId).toBe("trajectory");
    cancellation.abort();
    await expect(stream.next()).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("HTTP 401/429, Connect errors inside HTTP 200, and no token exposure", async () => {
  for (const status of [401, 429]) {
    const client = connectClient({
      baseURL: "https://example.invalid", token: "mock-secret",
      fetch: async () => Response.json({ code: "unauthenticated", message: "mock-secret" }, { status }),
    });
    await expect(run(client.unary(STATUS_METHOD, {}))).rejects.toThrow(expect.toSatisfy((error: Error) => !error.message.includes("mock-secret")));
  }
  const client = connectClient({
    baseURL: "https://example.invalid", token: "mock-secret",
    fetch: async () => new Response(new Uint8Array(encodeFrame({ error: { code: "resource_exhausted", message: "mock-secret" } }, 2)), {
      headers: { "content-type": "application/connect+proto" },
    }),
  });
  await expect(collect(client.stream(CHAT_METHOD, {}))).rejects.toThrow(/resource_exhausted: \[REDACTED\]/);
  expect(safeError("token=devin-session-token$abcdef")).toBe("token=[REDACTED]");
});
