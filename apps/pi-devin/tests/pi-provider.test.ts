import assert from "node:assert/strict";
import { test } from "node:test";
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
  assert.equal(events[0].type, "start");
  assert.equal(events.filter((event) => event.type === "done" || event.type === "error").length, 1);
  for (const kind of ["text", "thinking", "toolcall"]) assert.equal(events.filter((event) => event.type === kind + "_start").length, events.filter((event) => event.type === kind + "_end").length);
}

test("provider UID, payload replacement, headers, signatures and usage provenance are checked in the final request/response", async () => {
  const order: string[] = [];
  const fixture = await providerFixture({ chat: (request, index) => {
    order.push("request");
    assert.equal(request.body.chatModelUid, index === 1 ? "swe-2-high" : "swe-2-medium");
    assert.equal(request.body.prompt, "hook prompt");
    assert.equal((request.body.configuration as JsonObject).maxTokens, "5000");
    assert.equal(request.body.clientSessionId, "caller-session");
    assert.equal(request.headers.get("x-scope"), "header-value");
    assert.equal(request.headers.get("accept-encoding"), null);
    assert.equal(JSON.stringify(request.body).includes("No skills are configured"), false);
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
    assert.equal(typeof stream[Symbol.asyncIterator], "function");
    const { events, result } = await collect(stream); balanced(events);
    assert.deepEqual(order.slice(0, 4), ["payload", "request", "response", "frame"]);
    assert.equal(result.content.find((block) => block.type === "text")?.text, "hello 😀");
    assert.equal(result.providerThinkingLevel, "swe-2-high");
    assert.equal(result.responseModel, "response-other-uid");
    assert.equal(result.responseId, "reply-id");
    assert.equal(result.usage.totalTokens, 14);
    assert.deepEqual(result.diagnostics?.[0].details, { requestedUID: "swe-2-high", responseUID: "response-other-uid", usageUID: "usage-other-uid", costsUnknown: true, usageReported: true });
    const next = normalizeContext({ ...context(), messages: [...context().messages, result, { role: "user", content: "next", timestamp: 2 }] });
    // The second response uses the same fixture, but history consumption is checked with a different request UID.
    await collect(fixture.provider.streamSimple(fixture.model, next, { apiKey: providerCredential.sessionToken, reasoning: "medium", maxTokens: 6000, sessionId: "caller-session",
      headers: { "x-scope": "header-value", "accept-encoding": null },
      onPayload: (value) => ({ ...(value as JsonObject), prompt: "hook prompt", configuration: { ...((value as JsonObject).configuration as JsonObject), maxTokens: 5000 } }),
    }));
    const prompts = fixture.requests.filter((request) => request.method === CHAT_METHOD)[1].body.chatMessagePrompts as JsonObject[];
    const assistant = prompts.find((prompt) => prompt.source === "CHAT_MESSAGE_SOURCE_SYSTEM")!;
    assert.equal(assistant.modelUid, "swe-2-high");
    assert.equal(assistant.signature, "opaque-native-signature"); assert.equal(assistant.signatureType, "fixture-signature");
    assert.equal(assistant.thinkingId, "thinking-id"); assert.equal(assistant.thinking, "thinking");
    assert.equal(fixture.fingerprintCollections(), 1);
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
    assert.match(body.prompt as string, /old/); assert.match(body.prompt as string, /new instruction/);
    assert.deepEqual((body.tools as JsonObject[]).map((tool) => tool.name), ["current"]);
    const prompts = body.chatMessagePrompts as JsonObject[];
    assert.equal((prompts[0].images as JsonObject[])[0].base64Data, image.data);
    assert.equal((prompts[2].images as JsonObject[])[0].base64Data, image.data);
    assert.equal((prompts[1].toolCalls as JsonObject[])[0].id, "keep-tool-id"); assert.equal(prompts[2].toolCallId, "keep-tool-id");
    assert.equal(prompts.every((prompt) => prompt.promptCacheOptions === undefined), true);
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
      balanced(events); assert.equal(result.stopReason, "error"); assert.equal(fixture.chatCalls(), 1);
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
      assert.equal(result.stopReason, "error");
      if (i === 8) assert.match(result.errorMessage!, /all 8 Devin model HTTP requests/);
    }
    assert.equal(fixture.chatCalls(), 8);
    const state = fixture.provider.lifecycle.snapshot(); assert.equal(state.execution?.used, 8);
    const bodies = fixture.requests.filter((request) => request.method === CHAT_METHOD).map((request) => request.body);
    assert.equal(new Set(bodies.map((body) => body.executionId)).size, 1);
    assert.equal(new Set(bodies.map((body) => body.cascadeId)).size, 1);
    assert.equal((bodies[0].trajectoryReference as JsonObject).stepType, "CORTEX_STEP_TYPE_USER_INPUT");
    assert.equal((bodies[1].trajectoryReference as JsonObject).stepType, undefined);
  } finally { fixture.provider.shutdown(); }
});

for (const timeoutMs of [undefined, 5000]) test(`provider ${timeoutMs ?? "default 90000"}ms limit ends the final fetch signal`, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let finalSignal!: AbortSignal;
  const expected = timeoutMs ?? 90000;
  const fixture = await providerFixture({ chat: (request) => {
    finalSignal = request.signal;
    context.mock.timers.tick(expected - 1); assert.equal(finalSignal.aborted, false);
    context.mock.timers.tick(1); assert.equal(finalSignal.aborted, true);
    return new Promise(() => {});
  } });
  try {
    const { result } = await collect(fixture.provider.streamSimple(fixture.model, normalizeContext({ messages: [{ role: "user", content: "timeout", timestamp: 1 }] }), { apiKey: providerCredential.sessionToken, reasoning: "medium", timeoutMs }));
    assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, new RegExp(String(expected)));
  } finally { fixture.provider.shutdown(); }
});

test("even an uncooperative provider event observer ends on caller cancel and makes no further request", async () => {
  const controller = new AbortController(); const fixture = await providerFixture({ chat: () => streamResponse(finalFrames("partial")) });
  try {
    const { events, result } = await collect(fixture.provider.streamSimple(fixture.model, normalizeContext(context()), {
      apiKey: providerCredential.sessionToken, reasoning: "medium", signal: controller.signal,
      onProviderStreamEvent: () => { controller.abort(); return new Promise(() => {}); },
    }));
    balanced(events); assert.equal(result.stopReason, "aborted"); assert.equal(fixture.chatCalls(), 1);
  } finally { fixture.provider.shutdown(); }
});

test("payload identity changes and missing permission fail before the inference request", async () => {
  const fixture = await providerFixture();
  try {
    const result = await fixture.provider.streamSimple(fixture.model, normalizeContext(context()), {
      apiKey: providerCredential.sessionToken, reasoning: "medium", onPayload: (value) => ({ ...(value as JsonObject), cascadeId: "replacement" }),
    }).result();
    assert.equal(result.stopReason, "error"); assert.equal(fixture.chatCalls(), 0);
  } finally { fixture.provider.shutdown(); }
  const denied = await providerFixture({ status: { userStatus: { userId: "offline-user-id", planStatus: { planInfo: { devinInfo: { canUseCli: false } } } } } });
  try {
    const result = await denied.provider.streamSimple(denied.model, normalizeContext(context()), { apiKey: providerCredential.sessionToken, reasoning: "medium" }).result();
    assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /may use the CLI/); assert.equal(denied.chatCalls(), 0);
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
    assert.deepEqual(marks(plain.requests.find((request) => request.method === CHAT_METHOD)!.body), expected);
    const before = plain.requests.length;
    const previousEnv = process.env.PI_CACHE_RETENTION;
    try {
      process.env.PI_CACHE_RETENTION = "long";
      // Like Pi's built-in providers, retention is decided by option → provider env → process env.
      for (const options of [{ cacheRetention: "long" as const }, { env: { PI_CACHE_RETENTION: "long" } }, {}]) {
        const rejected = await plain.provider.streamSimple(plain.model, history, { apiKey: providerCredential.sessionToken, reasoning: "medium", ...options }).result();
        assert.equal(rejected.stopReason, "error"); assert.match(rejected.errorMessage!, /Long cache lifetime is not confirmed/);
      }
      assert.equal(plain.requests.length, before);
      const caller = await plain.provider.streamSimple(plain.model, history, { apiKey: providerCredential.sessionToken, reasoning: "medium", cacheRetention: "short" }).result();
      assert.equal(caller.stopReason, "stop", caller.errorMessage ?? "unexpected finish");
      assert.deepEqual(marks(plain.requests.filter((request) => request.method === CHAT_METHOD).at(-1)!.body), expected);
    } finally {
      if (previousEnv === undefined) delete process.env.PI_CACHE_RETENTION; else process.env.PI_CACHE_RETENTION = previousEnv;
    }
  } finally { plain.provider.shutdown(); }
  const extended = await providerFixture({ catalog: extendedCacheCatalog });
  try {
    assert.match(extended.model.id, /^gpt-5.6-sol/);
    const accepted = await extended.provider.streamSimple(extended.model, history, { apiKey: providerCredential.sessionToken, reasoning: "medium", cacheRetention: "long" }).result();
    assert.equal(accepted.stopReason, "stop", accepted.errorMessage ?? "unexpected finish");
    const body = extended.requests.find((request) => request.method === CHAT_METHOD)!.body;
    assert.equal(body.chatModelUid, "gpt-5-6-sol-medium");
    assert.deepEqual(marks(body), expected);
    assert.equal("systemPromptCacheOptions" in body, false);
  } finally { extended.provider.shutdown(); }
});
