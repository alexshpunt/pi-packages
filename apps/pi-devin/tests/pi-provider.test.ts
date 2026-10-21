import { expect, test, vi } from "vitest";
import { normalizeContext, type AssistantMessageEvent, type Context } from "@earendil-works/pi-ai";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import { encodeFrame } from "../src/core/protocol/transport.ts";
import { chatResponseCodec } from "../src/core/protocol/protobuf.ts";
import type { JsonObject } from "../src/core/types.ts";
import { errorStreamResponse, finalFrames, streamResponse } from "./helpers.ts";
import { extendedCacheCatalog, providerCredential, providerFixture } from "./provider-fixture.ts";

const context = (): Context => ({ systemPrompt: "Current Pi prompt", messages: [{ role: "user", content: "hello", timestamp: 1 }] });
async function collect(stream: ReturnType<Awaited<ReturnType<typeof providerFixture>>["provider"]["streamSimple"]>) {
  const events: AssistantMessageEvent[] = []; for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}
function balanced(events: AssistantMessageEvent[]) {
  expect(events[0].type).toBe("start");
  expect(events.filter((event) => event.type === "done" || event.type === "error").length).toBe(1);
  for (const kind of ["text", "thinking", "toolcall"]) expect(events.filter((event) => event.type === kind + "_start").length).toBe(events.filter((event) => event.type === kind + "_end").length);
}

test("provider UID, payload replacement, headers, signatures and usage provenance are checked in the final request/response", async () => {
  const order: string[] = [];
  const fixture = await providerFixture({ chat: (request, index) => {
    order.push("request");
    expect(request.body.chatModelUid).toBe(index === 1 ? "swe-2-high" : "swe-2-medium");
    expect(request.body.prompt).toBe("hook prompt");
    expect((request.body.configuration as JsonObject).maxTokens).toBe("5000");
    expect(request.body.clientSessionId).toBe("caller-session");
    expect(request.headers.get("x-scope")).toBe("header-value");
    expect(request.headers.get("accept-encoding")).toBe(null);
    expect(JSON.stringify(request.body).includes("No skills are configured")).toBe(false);
    return streamResponse([
      { messageId: "reply-id", deltaThinking: "thinking", deltaSignature: "opaque-native-signature", deltaSignatureType: "fixture-signature", thinkingId: "thinking-id" },
      { deltaText: "hello 😀", actualModelUid: "response-other-uid" },
      { stopReason: "STOP_REASON_STOP_PATTERN" },
      { usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, modelUid: "usage-other-uid" } },
    ]);
  } });
  try {
    const stream = fixture.provider.streamSimple(fixture.model, normalizeContext(context()), {
      apiKey: providerCredential.sessionToken, reasoning: "high", maxTokens: 6000, sessionId: "caller-session",
      headers: { "x-scope": "header-value", "accept-encoding": null },
      onPayload: async (value) => { order.push("payload"); return { ...(value as JsonObject), prompt: "hook prompt", configuration: { ...((value as JsonObject).configuration as JsonObject), maxTokens: 5000 } }; },
      onResponse: async () => { await Promise.resolve(); order.push("response"); },
      onProviderStreamEvent: async (value) => { await Promise.resolve(); order.push("frame"); (value as JsonObject).deltaText = "observer must not alter content"; },
    });
    expect(typeof stream[Symbol.asyncIterator]).toBe("function");
    const { events, result } = await collect(stream); balanced(events);
    expect(order.slice(0, 4)).toStrictEqual(["payload", "request", "response", "frame"]);
    expect(result.content.find((block) => block.type === "text")?.text).toBe("hello 😀");
    expect(result.providerThinkingLevel).toBe("swe-2-high");
    expect(result.responseModel).toBe("response-other-uid");
    expect(result.responseId).toBe("reply-id");
    expect(result.usage.totalTokens).toBe(14);
    expect(result.diagnostics?.[0].details).toStrictEqual({ requestedUID: "swe-2-high", responseUID: "response-other-uid", usageUID: "usage-other-uid", costsUnknown: true, usageReported: true });
    const next = normalizeContext({ ...context(), messages: [...context().messages, result, { role: "user", content: "next", timestamp: 2 }] });
    // The second response uses the same fixture, but history consumption is checked with a different request UID.
    await collect(fixture.provider.streamSimple(fixture.model, next, { apiKey: providerCredential.sessionToken, reasoning: "medium", maxTokens: 6000, sessionId: "caller-session",
      headers: { "x-scope": "header-value", "accept-encoding": null },
      onPayload: (value) => ({ ...(value as JsonObject), prompt: "hook prompt", configuration: { ...((value as JsonObject).configuration as JsonObject), maxTokens: 5000 } }),
    }));
    const prompts = fixture.requests.filter((request) => request.method === CHAT_METHOD)[1].body.chatMessagePrompts as JsonObject[];
    const assistant = prompts.find((prompt) => prompt.source === "CHAT_MESSAGE_SOURCE_SYSTEM")!;
    expect(assistant.modelUid).toBe("swe-2-high");
    expect(assistant.signature).toBe("opaque-native-signature"); expect(assistant.signatureType).toBe("fixture-signature");
    expect(assistant.thinkingId).toBe("thinking-id"); expect(assistant.thinking).toBe("thinking");
    expect(fixture.fingerprintCollections()).toBe(1);
  } finally { fixture.provider.shutdown(); }
});

test("current system/tool changes and user and tool-result images are kept in the final protobuf", async () => {
  const fixture = await providerFixture();
  const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };
  const history = normalizeContext({ messages: [
    { role: "system", content: "old", toolsAdded: [{ name: "old", description: "old", parameters: { type: "object" } }], timestamp: 1 },
    { role: "user", content: [{ type: "text", text: "image" }, image], timestamp: 2 },
    { role: "assistant", content: [{ type: "toolCall", id: "keep-tool-id", name: "old", arguments: {} }], api: "other-api", provider: "other", model: "other-model", timestamp: 3,
      stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: "toolResult", toolCallId: "keep-tool-id", toolName: "old", content: [{ type: "text", text: "result" }, image], isError: false, timestamp: 4 },
    { role: "system", content: "new instruction", toolsRemoved: [{ name: "old" }], toolsAdded: [{ name: "current", description: "new", parameters: { type: "object", properties: { value: { type: "string" } } } }], timestamp: 5 },
  ] });
  try {
    await collect(fixture.provider.streamSimple(fixture.model, history, { apiKey: providerCredential.sessionToken, reasoning: "medium", cacheRetention: "none" }));
    const body = fixture.requests.find((request) => request.method === CHAT_METHOD)!.body;
    expect(body.prompt as string).toMatch(/old/); expect(body.prompt as string).toMatch(/new instruction/);
    expect((body.tools as JsonObject[]).map((tool) => tool.name)).toStrictEqual(["current"]);
    const prompts = body.chatMessagePrompts as JsonObject[];
    expect((prompts[0].images as JsonObject[])[0].base64Data).toBe(image.data);
    expect((prompts[2].images as JsonObject[])[0].base64Data).toBe(image.data);
    expect((prompts[1].toolCalls as JsonObject[])[0].id).toBe("keep-tool-id"); expect(prompts[2].toolCallId).toBe("keep-tool-id");
    expect(prompts.every((prompt) => prompt.promptCacheOptions === undefined)).toBe(true);
  } finally { fixture.provider.shutdown(); }
});

test("a failed partial tool and a truncated stream do not become success and content events are closed", async () => {
  for (const response of [
    errorStreamResponse("internal", "failed after partial", [{ deltaText: "PARTIAL", deltaToolCalls: [{ id: "call", name: "current", argumentsJson: '{"x":1}' }] }]),
    new Response(new Uint8Array(encodeFrame(chatResponseCodec.encode({ deltaText: "truncated" }))), { headers: { "content-type": "application/connect+proto" } }),
  ]) {
    const fixture = await providerFixture({ chat: () => response });
    try {
      const { events, result } = await collect(fixture.provider.streamSimple(fixture.model, normalizeContext(context()), { apiKey: providerCredential.sessionToken, reasoning: "medium" }));
      balanced(events); expect(result.stopReason).toBe("error"); expect(fixture.chatCalls()).toBe(1);
    } finally { fixture.provider.shutdown(); }
  }
});

test("the fixed 8-call budget is not reset at host retry boundaries and blocks before sending", async () => {
  const fixture = await providerFixture({ chat: () => Response.json({}, { status: 429 }) });
  fixture.provider.lifecycle.begin("agent"); fixture.provider.lifecycle.agentStarted();
  try {
    for (let i = 0; i < 9; i++) {
      if (i) fixture.provider.lifecycle.agentStarted();
      const { result } = await collect(fixture.provider.streamSimple(fixture.model, normalizeContext(context()), { apiKey: providerCredential.sessionToken, reasoning: "medium" }));
      expect(result.stopReason).toBe("error");
      if (i === 8) expect(result.errorMessage!).toMatch(/all 8 Devin model HTTP requests/);
    }
    expect(fixture.chatCalls()).toBe(8);
    const state = fixture.provider.lifecycle.snapshot(); expect(state.execution?.used).toBe(8);
    const bodies = fixture.requests.filter((request) => request.method === CHAT_METHOD).map((request) => request.body);
    expect(new Set(bodies.map((body) => body.executionId)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.cascadeId)).size).toBe(1);
    expect((bodies[0].trajectoryReference as JsonObject).stepType).toBe("CORTEX_STEP_TYPE_USER_INPUT");
    expect((bodies[1].trajectoryReference as JsonObject).stepType).toBe(undefined);
  } finally { fixture.provider.shutdown(); }
});

for (const timeoutMs of [undefined, 5000]) test(`provider ${timeoutMs ?? "default 90000"}ms limit ends the final fetch signal`, async (context) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); context.onTestFinished(() => { vi.useRealTimers(); });
  let finalSignal!: AbortSignal;
  const expected = timeoutMs ?? 90000;
  const fixture = await providerFixture({ chat: (request) => {
    finalSignal = request.signal;
    vi.advanceTimersByTime(expected - 1); expect(finalSignal.aborted).toBe(false);
    vi.advanceTimersByTime(1); expect(finalSignal.aborted).toBe(true);
    return new Promise(() => {});
  } });
  try {
    const { result } = await collect(fixture.provider.streamSimple(fixture.model, normalizeContext({ messages: [{ role: "user", content: "timeout", timestamp: 1 }] }), { apiKey: providerCredential.sessionToken, reasoning: "medium", timeoutMs }));
    expect(result.stopReason).toBe("error"); expect(result.errorMessage!).toMatch(new RegExp(String(expected)));
  } finally { fixture.provider.shutdown(); }
});

test("even an uncooperative provider event observer ends on caller cancel and makes no further request", async () => {
  const controller = new AbortController(); const fixture = await providerFixture({ chat: () => streamResponse(finalFrames("partial")) });
  try {
    const { events, result } = await collect(fixture.provider.streamSimple(fixture.model, normalizeContext(context()), {
      apiKey: providerCredential.sessionToken, reasoning: "medium", signal: controller.signal,
      onProviderStreamEvent: () => { controller.abort(); return new Promise(() => {}); },
    }));
    balanced(events); expect(result.stopReason).toBe("aborted"); expect(fixture.chatCalls()).toBe(1);
  } finally { fixture.provider.shutdown(); }
});

test("payload identity changes and missing permission fail before the inference request", async () => {
  const fixture = await providerFixture();
  try {
    const result = await fixture.provider.streamSimple(fixture.model, normalizeContext(context()), {
      apiKey: providerCredential.sessionToken, reasoning: "medium", onPayload: (value) => ({ ...(value as JsonObject), cascadeId: "replacement" }),
    }).result();
    expect(result.stopReason).toBe("error"); expect(fixture.chatCalls()).toBe(0);
  } finally { fixture.provider.shutdown(); }
  const denied = await providerFixture({ status: { userStatus: { userId: "offline-user-id", planStatus: { planInfo: { devinInfo: { canUseCli: false } } } } } });
  try {
    const result = await denied.provider.streamSimple(denied.model, normalizeContext(context()), { apiKey: providerCredential.sessionToken, reasoning: "medium" }).result();
    expect(result.stopReason).toBe("error"); expect(result.errorMessage!).toMatch(/may use the CLI/); expect(denied.chatCalls()).toBe(0);
  } finally { denied.provider.shutdown(); }
});

test("prompt cache: by default only user and tool results are marked EPHEMERAL, and long is sent only for 24h catalog models", async () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const history = normalizeContext({ messages: [
    { role: "user", content: "cache me", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "cache-tool", name: "lookup", arguments: {} }], api: "other-api", provider: "other", model: "other",
      stopReason: "toolUse", usage, timestamp: 2 },
    { role: "toolResult", toolCallId: "cache-tool", toolName: "lookup", content: [{ type: "text", text: "result" }], isError: false, timestamp: 3 },
  ] });
  const marks = (body: JsonObject) => (body.chatMessagePrompts as JsonObject[]).map((prompt) => [prompt.source, (prompt.promptCacheOptions as JsonObject | undefined)?.type ?? null]);
  const expected = [["CHAT_MESSAGE_SOURCE_USER", "CACHE_CONTROL_TYPE_EPHEMERAL"], ["CHAT_MESSAGE_SOURCE_SYSTEM", null], ["CHAT_MESSAGE_SOURCE_TOOL", "CACHE_CONTROL_TYPE_EPHEMERAL"]];
  const plain = await providerFixture();
  try {
    await collect(plain.provider.streamSimple(plain.model, history, { apiKey: providerCredential.sessionToken, reasoning: "medium" }));
    expect(marks(plain.requests.find((request) => request.method === CHAT_METHOD)!.body)).toStrictEqual(expected);
    const before = plain.requests.length;
    const previousEnv = process.env.PI_CACHE_RETENTION;
    try {
      process.env.PI_CACHE_RETENTION = "long";
      // Like Pi's built-in providers, retention is decided by option → provider env → process env.
      for (const options of [{ cacheRetention: "long" as const }, { env: { PI_CACHE_RETENTION: "long" } }, {}]) {
        const rejected = await plain.provider.streamSimple(plain.model, history, { apiKey: providerCredential.sessionToken, reasoning: "medium", ...options }).result();
        expect(rejected.stopReason).toBe("error"); expect(rejected.errorMessage!).toMatch(/Long cache lifetime is not confirmed/);
      }
      expect(plain.requests.length).toBe(before);
      const caller = await plain.provider.streamSimple(plain.model, history, { apiKey: providerCredential.sessionToken, reasoning: "medium", cacheRetention: "short" }).result();
      expect(caller.stopReason, caller.errorMessage ?? "unexpected finish").toBe("stop");
      expect(marks(plain.requests.filter((request) => request.method === CHAT_METHOD).at(-1)!.body)).toStrictEqual(expected);
    } finally {
      if (previousEnv === undefined) delete process.env.PI_CACHE_RETENTION; else process.env.PI_CACHE_RETENTION = previousEnv;
    }
  } finally { plain.provider.shutdown(); }
  const extended = await providerFixture({ catalog: extendedCacheCatalog });
  try {
    expect(extended.model.id).toMatch(/^gpt-5.6-sol/);
    const accepted = await extended.provider.streamSimple(extended.model, history, { apiKey: providerCredential.sessionToken, reasoning: "medium", cacheRetention: "long" }).result();
    expect(accepted.stopReason, accepted.errorMessage ?? "unexpected finish").toBe("stop");
    const body = extended.requests.find((request) => request.method === CHAT_METHOD)!.body;
    expect(body.chatModelUid).toBe("gpt-5-6-sol-medium");
    expect(marks(body)).toStrictEqual(expected);
    expect("systemPromptCacheOptions" in body).toBe(false);
  } finally { extended.provider.shutdown(); }
});
