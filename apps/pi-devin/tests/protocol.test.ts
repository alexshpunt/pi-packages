import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { expect, test } from "vitest";
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
  expect([...chatRequestCodec.encode({ prompt: "A" })]).toStrictEqual([0x12, 0x01, 0x41]);
  expect(() => chatRequestCodec.encode({ chatModelUid: "test", unknownField: true })).toThrow(/Field not in the protobuf schema/);
  expect(() => chatRequestCodec.encode({ requestType: "UNKNOWN_ENUM" })).toThrow(/Unknown protobuf enum/);
  const bytes = Buffer.concat([encodeFrame({ deltaText: "héllo wörld🙂" }), encodeFrame({}, 2)]);
  for (const size of [1, 2, 4, 5, 7, bytes.length]) {
    const result = await collect(bytes, size);
    expect(result[0].data.deltaText).toBe("héllo wörld🙂");
    expect(result[1].isEnd).toBe(true);
  }
});

test("Connect frames: truncation, missing end, compression, oversize and data after the end", async () => {
  const data = encodeFrame({ deltaText: "hello" });
  await expect(collect(data.subarray(0, data.length - 1))).rejects.toThrow(/incomplete/);
  await expect(collect(data)).rejects.toThrow(/without EndStream/);
  await expect(collect(encodeFrame({}, 1))).rejects.toThrow(/compressed frame/);
  await expect(collect(encodeFrame({}, 4))).rejects.toThrow(/flags/);
  await expect(collect(Buffer.concat([encodeFrame({}, 2), data]))).rejects.toThrow(/follows EndStream/);
  const header = Buffer.alloc(5); header.writeUInt32BE(9 * 1024 * 1024, 1);
  await expect(collect(header)).rejects.toThrow(/8 MiB/);
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
  expect(result.usage.totalTokens).toBe(12231);
  expect(result.lastUsageFrameIndex).toBe(5);
  expect(result.idlessToolDeltaCount).toBe(2);
  expect(JSON.parse(result.message.toolCalls![0].argumentsJson)).toStrictEqual({ a: 17, b: 25 });
  expect(result.message.thinking).toBe("calculating");
});

test("ambiguous tool deltas and invalid arguments never become executable calls", () => {
  const acc = new ChatAccumulator();
  expect(() => acc.accept({ deltaToolCalls: [{ argumentsJson: "{}" }] })).toThrow(/Cannot attach/);
  const parallel = new ChatAccumulator();
  parallel.accept({ deltaToolCalls: [{ id: "a", name: "add" }, { id: "b", name: "add" }] });
  expect(() => parallel.accept({ deltaToolCalls: [{ argumentsJson: "{}" }] })).toThrow(/Cannot attach/);
  for (const argumentsJson of ["[1,2]", '{"unfinished":']) {
    const invalid = new ChatAccumulator();
    invalid.accept({ deltaToolCalls: [{ id: "a", name: "add", argumentsJson }], stopReason: "STOP_REASON_FUNCTION_CALL" });
    invalid.accept({}, true);
    expect(() => invalid.finish()).toThrow(/JSON/);
  }
});

test("replay of 7 preserved captures: protobuf request/response serialization and field preservation", async () => {
  const separator = "[----------------------next message----------------------]";
  for (const sample of ["01", "02", "03", "04", "05", "06", "07-image"]) {
    const path = new URL(`./fixtures/captured-samples/GetChatMessage/${sample}/response.txt`, import.meta.url);
    const text = await readFile(path, "utf8");
    const request = capturedJSON(await readFile(new URL("request.txt", path), "utf8"));
    const decodedRequest = chatRequestCodec.decode(chatRequestCodec.encode(request));
    expect(decodedRequest.chatModelUid, sample).toBe(request.chatModelUid);
    expect(decodedRequest.prompt, sample).toBe(request.prompt);
    expect(object(decodedRequest.metadata, "metadata").f, sample).toBe(object(request.metadata, "metadata").f);
    expect(decodedRequest.tools, sample).toStrictEqual(request.tools);
    const acc = new ChatAccumulator();
    for (const part of text.split(separator).filter((value) => value.trim())) {
      const frame = capturedJSON(part);
      acc.accept(chatResponseCodec.decode(chatResponseCodec.encode(frame)));
    }
    // The captures are protobuf converted to text, so the real EndStream bytes were not preserved.
    acc.accept({}, true);
    const result = acc.finish();
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
  const client = new ConnectClient({
    baseURL: "https://example.invalid", token: "mock-secret",
    fetch: async (_url, init) => {
      requests++;
      expect(new Headers(init?.headers).get("Authorization")).toBe("Basic mock-secret-mock-secret");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeTruthy(); if (!init?.signal) throw new Error("unreachable");
      expect(init.signal).not.toBe(controller.signal);
      const bytes = Buffer.from(init.body as Uint8Array);
      const body = chatRequestCodec.decode(bytes.subarray(5));
      expect(Number(object(body.configuration, "configuration").maxTokens)).toBe(128);
      expect(object(body.metadata, "metadata").apiKey).toBe("mock-secret");
      firstTrace = new Headers(init?.headers).get("sentry-trace")!;
      expect(firstTrace).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-0$/);
      controller.abort();
      expect(init.signal.aborted).toBe(true);
      return new Response(new Uint8Array(encodeFrame({}, 2)), { headers: { "content-type": "application/connect+proto" } });
    },
  });
  await expect(async () => {
    for await (const _ of client.stream(CHAT_METHOD, request, controller.signal)) {}
  }).rejects.toThrow();
  expect(requests).toBe(1);

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
    const local = new ConnectClient({ baseURL: `http://127.0.0.1:${address.port}`, token: "mock-secret", timeoutMs: 2000 });
    const cancellation = new AbortController();
    const stream = local.stream(CHAT_METHOD, request, cancellation.signal);
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
    const decoded = chatRequestCodec.decode(sent.body.subarray(5));
    expect(Number(object(decoded.configuration, "configuration").maxTokens)).toBe(128);
    expect(object(decoded.metadata, "metadata").apiKey).toBe("mock-secret");
    expect(object(decoded.trajectoryReference, "trajectory").trajectoryId).toBe("trajectory");
    cancellation.abort();
    await expect(stream.next()).rejects.toThrow();
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
    await expect(client.unary(STATUS_METHOD, {})).rejects.toThrow(expect.toSatisfy((error: Error) => !error.message.includes("mock-secret")));
  }
  const client = new ConnectClient({
    baseURL: "https://example.invalid", token: "mock-secret",
    fetch: async () => new Response(new Uint8Array(encodeFrame({ error: { code: "resource_exhausted", message: "mock-secret" } }, 2)), {
      headers: { "content-type": "application/connect+proto" },
    }),
  });
  await expect(async () => {
    for await (const _ of client.stream(CHAT_METHOD, {})) {}
  }).rejects.toThrow(/resource_exhausted: \[REDACTED\]/);
  expect(safeError("token=devin-session-token$abcdef")).toBe("token=[REDACTED]");
});
