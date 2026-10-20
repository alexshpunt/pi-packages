import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { test } from "node:test";
import { ChatAccumulator, chatRequest } from "../src/core/inference/chat.ts";
import { ConnectClient, decodeFrames, encodeFrame as envelope, safeError } from "../src/core/protocol/transport.ts";
import { CHAT_METHOD, chatRequestCodec, chatResponseCodec } from "../src/core/protocol/protobuf.ts";
import { object, type JsonObject } from "../src/core/types.ts";
import { STATUS_METHOD } from "./helpers.ts";

function encodeFrame(value: JsonObject, flags = 0): Buffer {
  return envelope(flags & 2 ? Buffer.from(JSON.stringify(value)) : chatResponseCodec.encode(value), flags);
}

function capturedJSON(text: string): JsonObject {
  return JSON.parse(text, (_key, value) => typeof value === "string"
    ? value.replace(/^Exa[A-Za-z0-9]+_[A-Za-z0-9]+_([A-Z][A-Z0-9_]+)$/, "$1") : value);
}

async function* chunks(bytes: Uint8Array, size: number) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function collect(bytes: Uint8Array, size = bytes.length) {
  const frames = [];
  for await (const frame of decodeFrames(chunks(bytes, size))) frames.push(frame);
  return frames;
}

test("Connect frames: 1-byte boundaries, UTF-8 and consecutive frames", async () => {
  assert.deepEqual([...chatRequestCodec.encode({ prompt: "A" })], [0x12, 0x01, 0x41]);
  assert.throws(() => chatRequestCodec.encode({ chatModelUid: "test", unknownField: true }), /Field not in the protobuf schema/);
  assert.throws(() => chatRequestCodec.encode({ requestType: "UNKNOWN_ENUM" }), /Unknown protobuf enum/);
  const bytes = Buffer.concat([encodeFrame({ deltaText: "héllo wörld🙂" }), encodeFrame({}, 2)]);
  for (const size of [1, 2, 4, 5, 7, bytes.length]) {
    const result = await collect(bytes, size);
    assert.equal(result[0].data.deltaText, "héllo wörld🙂");
    assert.equal(result[1].isEnd, true);
  }
});

test("Connect frames: truncation, missing end, compression, oversize and data after the end", async () => {
  const data = encodeFrame({ deltaText: "hello" });
  await assert.rejects(collect(data.subarray(0, data.length - 1)), /incomplete/);
  await assert.rejects(collect(data), /without EndStream/);
  await assert.rejects(collect(encodeFrame({}, 1)), /compressed frame/);
  await assert.rejects(collect(encodeFrame({}, 4)), /flags/);
  await assert.rejects(collect(Buffer.concat([encodeFrame({}, 2), data])), /follows EndStream/);
  const header = Buffer.alloc(5); header.writeUInt32BE(9 * 1024 * 1024, 1);
  await assert.rejects(collect(header), /8 MiB/);
});

test("keeps tool arguments without an ID and usage after stopReason", () => {
  const acc = new ChatAccumulator();
  acc.accept({ deltaToolCalls: [{ id: "call-1", name: "add" }], deltaThinking: "calculating" });
  acc.accept({ deltaToolCalls: [{ argumentsJson: '{"a":17,' }] });
  acc.accept({ deltaToolCalls: [{ argumentsJson: '"b":25}' }] });
  acc.accept({ stopReason: "STOP_REASON_FUNCTION_CALL" });
  acc.accept({ usage: { inputTokens: "235", outputTokens: "35", cacheReadTokens: "11961" } });
  acc.accept({ usage: { modelUid: "test" } });
  acc.accept({}, true);
  const result = acc.finish();
  assert.equal(result.usage.totalTokens, 12231);
  assert.equal(result.lastUsageFrameIndex, 5);
  assert.equal(result.idlessToolDeltaCount, 2);
  assert.deepEqual(JSON.parse(result.message.toolCalls![0].argumentsJson), { a: 17, b: 25 });
  assert.equal(result.message.thinking, "calculating");
});

test("ambiguous tool deltas and invalid arguments never become executable calls", () => {
  const acc = new ChatAccumulator();
  assert.throws(() => acc.accept({ deltaToolCalls: [{ argumentsJson: "{}" }] }), /Cannot attach/);
  const parallel = new ChatAccumulator();
  parallel.accept({ deltaToolCalls: [{ id: "a", name: "add" }, { id: "b", name: "add" }] });
  assert.throws(() => parallel.accept({ deltaToolCalls: [{ argumentsJson: "{}" }] }), /Cannot attach/);
  for (const argumentsJson of ["[1,2]", '{"unfinished":']) {
    const invalid = new ChatAccumulator();
    invalid.accept({ deltaToolCalls: [{ id: "a", name: "add", argumentsJson }], stopReason: "STOP_REASON_FUNCTION_CALL" });
    invalid.accept({}, true);
    assert.throws(() => invalid.finish(), /JSON/);
  }
});

test("replay of 7 preserved captures: protobuf request/response serialization and field preservation", async () => {
  const separator = "[----------------------next message----------------------]";
  for (const sample of ["01", "02", "03", "04", "05", "06", "07-image"]) {
    const path = new URL(`./fixtures/captured-samples/GetChatMessage/${sample}/response.txt`, import.meta.url);
    const text = await readFile(path, "utf8");
    const request = capturedJSON(await readFile(new URL("request.txt", path), "utf8"));
    const decodedRequest = chatRequestCodec.decode(chatRequestCodec.encode(request));
    assert.equal(decodedRequest.chatModelUid, request.chatModelUid, sample);
    assert.equal(decodedRequest.prompt, request.prompt, sample);
    assert.equal(object(decodedRequest.metadata, "metadata").f, object(request.metadata, "metadata").f, sample);
    assert.deepEqual(decodedRequest.tools, request.tools, sample);
    const acc = new ChatAccumulator();
    for (const part of text.split(separator).filter((value) => value.trim())) {
      const frame = capturedJSON(part);
      acc.accept(chatResponseCodec.decode(chatResponseCodec.encode(frame)));
    }
    // The captures are protobuf converted to text, so the real EndStream bytes were not preserved.
    acc.accept({}, true);
    const result = acc.finish();
    assert.equal(result.usageReported, true, sample);
    assert.ok(result.lastUsageFrameIndex! > result.stopFrameIndex!, sample);
    if (sample === "04") {
      assert.equal(result.message.toolCalls?.length, 1);
      assert.deepEqual(JSON.parse(result.message.toolCalls![0].argumentsJson), { command: "ls -la ~/Desktop" });
      assert.equal(result.usage.totalTokens, 12231);
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
  const client = new ConnectClient({
    baseURL: "https://example.invalid", token: "mock-secret",
    fetch: async (_url, init) => {
      requests++;
      assert.equal(new Headers(init?.headers).get("Authorization"), "Basic mock-secret-mock-secret");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      assert.notEqual(init.signal, controller.signal);
      const bytes = Buffer.from(init.body as Uint8Array);
      const body = chatRequestCodec.decode(bytes.subarray(5));
      assert.equal(Number(object(body.configuration, "configuration").maxTokens), 128);
      assert.equal(object(body.metadata, "metadata").apiKey, "mock-secret");
      firstTrace = new Headers(init?.headers).get("sentry-trace")!;
      assert.match(firstTrace, /^[0-9a-f]{32}-[0-9a-f]{16}-0$/);
      controller.abort();
      assert.equal(init.signal.aborted, true);
      return new Response(new Uint8Array(encodeFrame({}, 2)), { headers: { "content-type": "application/connect+proto" } });
    },
  });
  await assert.rejects(async () => {
    for await (const _ of client.stream(CHAT_METHOD, request, controller.signal)) {}
  });
  assert.equal(requests, 1);

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
    assert.ok(address && typeof address !== "string");
    const local = new ConnectClient({ baseURL: `http://127.0.0.1:${address.port}`, token: "mock-secret", timeoutMs: 2000 });
    const cancellation = new AbortController();
    const stream = local.stream(CHAT_METHOD, request, cancellation.signal);
    assert.equal((await stream.next()).value?.data.deltaText, "streaming");
    const sent = await observed;
    assert.deepEqual(Object.keys(sent.headers).sort(), [
      "accept", "accept-encoding", "authorization", "connect-protocol-version", "content-length", "content-type", "host", "sentry-trace",
    ]);
    assert.equal(sent.headers["content-type"], "application/connect+proto");
    assert.equal(Number(sent.headers["content-length"]), sent.body.byteLength);
    assert.equal(sent.headers.authorization, "Basic mock-secret-mock-secret");
    assert.match(String(sent.headers["sentry-trace"]), /^[0-9a-f]{32}-[0-9a-f]{16}-0$/);
    assert.notEqual(sent.headers["sentry-trace"], firstTrace);
    const decoded = chatRequestCodec.decode(sent.body.subarray(5));
    assert.equal(Number(object(decoded.configuration, "configuration").maxTokens), 128);
    assert.equal(object(decoded.metadata, "metadata").apiKey, "mock-secret");
    assert.equal(object(decoded.trajectoryReference, "trajectory").trajectoryId, "trajectory");
    cancellation.abort();
    await assert.rejects(stream.next());
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("HTTP 401/429, Connect errors inside HTTP 200, and no token exposure", async () => {
  for (const status of [401, 429]) {
    const client = new ConnectClient({
      baseURL: "https://example.invalid", token: "mock-secret",
      fetch: async () => Response.json({ code: "unauthenticated", message: "mock-secret" }, { status }),
    });
    await assert.rejects(client.unary(STATUS_METHOD, {}), (error: Error) => !error.message.includes("mock-secret"));
  }
  const client = new ConnectClient({
    baseURL: "https://example.invalid", token: "mock-secret",
    fetch: async () => new Response(new Uint8Array(encodeFrame({ error: { code: "resource_exhausted", message: "mock-secret" } }, 2)), {
      headers: { "content-type": "application/connect+proto" },
    }),
  });
  await assert.rejects(async () => {
    for await (const _ of client.stream(CHAT_METHOD, {})) {}
  }, /resource_exhausted: \[REDACTED\]/);
  assert.equal(safeError("token=devin-session-token$abcdef"), "token=[REDACTED]");
});
