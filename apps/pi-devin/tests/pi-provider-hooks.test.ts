import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, type OAuthCredential } from "@earendil-works/pi-ai";
import { createDevinProvider } from "../src/pi/provider.ts";
import { chatResponseCodec } from "../src/core/protocol/protobuf.ts";
import { encodeFrame } from "../src/core/protocol/transport.ts";
import type { JsonObject } from "../src/core/types.ts";
import { finalFrames, STATUS_METHOD, streamResponse } from "./helpers.ts";
import { providerCredential, providerFixture, providerHostCredential } from "./provider-fixture.ts";

const context = () => normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 1 }] });
const options = { apiKey: providerCredential.sessionToken, reasoning: "high" as const };
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test("the body is not read before onResponse completes and the payload UID replacement is kept", async () => {
  let hasObservedResponse = false, reads = 0;
  const fixture = await providerFixture({ chat: (request) => {
    assert.equal(request.body.chatModelUid, "swe-2-max");
    const bytes = Buffer.concat([...finalFrames("replacement").map((frame) => encodeFrame(chatResponseCodec.encode(frame))), encodeFrame(Buffer.from("{}"), 2)]);
    return new Response(new ReadableStream({ pull(controller) { assert.equal(hasObservedResponse, true); reads++; controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 }), { headers: { "content-type": "application/connect+proto" } });
  } });
  try {
    const result = await fixture.provider.streamSimple(fixture.model, context(), { ...options,
      onPayload: (payload) => ({ ...(payload as JsonObject), chatModelUid: "swe-2-max" }),
      onResponse: async () => { assert.equal(reads, 0); await Promise.resolve(); hasObservedResponse = true; },
    }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage ?? ""); assert.equal(result.providerThinkingLevel, "swe-2-max"); assert.equal(reads, 1);
  } finally { fixture.provider.shutdown(); }
});

test("a response hook failure strips tokens, fingerprints and headers and does not wait for an uncooperative body cancel", async () => {
  let fingerprint = "", cancels = 0;
  const fixture = await providerFixture({ chat: (request) => {
    fingerprint = String((request.body.metadata as JsonObject).f);
    return new Response(new ReadableStream({ cancel() { cancels++; return new Promise(() => {}); } }, { highWaterMark: 0 }));
  } });
  try {
    const stream = fixture.provider.streamSimple(fixture.model, context(), { ...options, headers: { "x-sensitive": "fake-sensitive-header" },
      onResponse: () => { throw new Error(`${providerCredential.sessionToken} ${fingerprint} fake-sensitive-header`); },
    });
    const result = await Promise.race([stream.result(), new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined)))]);
    assert.ok(result, "an uncooperative cleanup blocked the response from ending"); assert.equal(result.stopReason, "error"); assert.equal(cancels, 1);
    const serialized = JSON.stringify(result);
    for (const secret of [providerCredential.sessionToken, fingerprint, "fake-sensitive-header"]) assert.equal(serialized.includes(secret), false);
  } finally { fixture.provider.shutdown(); }
});

test("a frame observer failure stops the open reader and does not wait for an uncooperative cancel", async () => {
  let sent = false, cancels = 0;
  const fixture = await providerFixture({ chat: () => new Response(new ReadableStream({
    pull(controller) { if (!sent) { sent = true; controller.enqueue(encodeFrame(chatResponseCodec.encode({ deltaText: "partial" }))); } },
    cancel() { cancels++; return new Promise(() => {}); },
  }, { highWaterMark: 0 })) });
  try {
    const stream = fixture.provider.streamSimple(fixture.model, context(), { ...options, onProviderStreamEvent: () => { throw new Error("observer failed"); } });
    const result = await Promise.race([stream.result(), new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined)))]);
    assert.ok(result); assert.equal(result.stopReason, "error"); assert.equal(cancels, 1);
  } finally { fixture.provider.shutdown(); }
});

test("even an uncooperative payload hook ends within the RPC deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] }); const fixture = await providerFixture();
  try {
    const result = await fixture.provider.streamSimple(fixture.model, normalizeContext({ messages: [] }), { ...options, timeoutMs: 5000,
      onPayload: () => { context.mock.timers.tick(5000); return new Promise(() => {}); },
    }).result();
    assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /5000/); assert.equal(fixture.chatCalls(), 0);
  } finally { fixture.provider.shutdown(); }
});

test("server redaction clears the final text/thinking/tool payload and does not turn failure into success", async () => {
  const fixture = await providerFixture({ chat: () => streamResponse([
    { deltaText: "private text", deltaThinking: "private thought", deltaSignature: "private signature", deltaToolCalls: [{ id: "call", name: "tool", argumentsJson: '{"private":true}' }] },
    { redact: true },
  ]) });
  try {
    const result = await fixture.provider.streamSimple(fixture.model, context(), options).result();
    assert.equal(result.stopReason, "error"); assert.equal(JSON.stringify(result).includes("private"), false);
  } finally { fixture.provider.shutdown(); }
});

test("a 401 blocks waiting requests of the same run and later direct calls", async () => {
  const started = gate<void>(), response = gate<Response>();
  const fixture = await providerFixture({ chat: () => { started.resolve(); return response.promise; } });
  fixture.provider.lifecycle.begin("agent");
  try {
    const first = fixture.provider.streamSimple(fixture.model, context(), options), second = fixture.provider.streamSimple(fixture.model, context(), options);
    await started.promise; response.resolve(Response.json({}, { status: 401 }));
    const results = await Promise.all([first.result(), second.result()]);
    assert.equal(results.every((result) => result.stopReason === "error"), true); assert.equal(fixture.chatCalls(), 1);
    fixture.provider.lifecycle.finish(); fixture.provider.lifecycle.begin("agent");
    const before = fixture.requests.length;
    const rejected = await fixture.provider.streamSimple(fixture.model, context(), options).result();
    assert.equal(rejected.stopReason, "error"); assert.match(rejected.errorMessage!, /login/); assert.equal(fixture.requests.length, before);
  } finally { fixture.provider.shutdown(); }
});

test("a late 401 from an older auth generation does not cancel runs after a new login", async () => {
  const f = await providerFixture(); f.provider.shutdown();
  const statusStarted = gate<void>(), oldStatus = gate<Response>(), chatStarted = gate<void>(), chatResponse = gate<Response>();
  let statusCalls = 0, chatSignal!: AbortSignal;
  const provider = createDevinProvider({ ...f.dependencies, fetch: async (url, init) => {
    if (String(url).endsWith(STATUS_METHOD) && ++statusCalls === 1) { statusStarted.resolve(); return oldStatus.promise; }
    if (String(url).endsWith("/GetChatMessage")) { chatSignal = init!.signal!; chatStarted.resolve(); return chatResponse.promise; }
    return f.dependencies.fetch(url, init);
  } });
  const refreshCatalog = (credential: OAuthCredential) => provider.refreshModels({ credential, allowNetwork: true, force: true, signal: new AbortController().signal, publish: async (value) => { value.update?.(); return true; } });
  try {
    await refreshCatalog(providerHostCredential);
    const refresh = provider.auth.oauth!.refresh(providerHostCredential, new AbortController().signal);
    await statusStarted.promise;
    const credential = await provider.auth.oauth!.login({ signal: new AbortController().signal, notify: () => {}, prompt: async (prompt) => prompt.type === "select" ? "manual" : "late-generation-code" });
    await refreshCatalog(credential);
    const model = provider.getModels().find((model) => model.id === "swe-2")!;
    const stream = provider.streamSimple(model, context(), { ...options, apiKey: credential.access });
    await chatStarted.promise;
    const rejection = assert.rejects(refresh, /authentication|401/); oldStatus.resolve(Response.json({}, { status: 401 })); await rejection;
    assert.equal(chatSignal.aborted, false);
    chatResponse.resolve(streamResponse(finalFrames()));
    assert.equal((await stream.result()).stopReason, "stop");
    assert.equal((await provider.auth.oauth!.toAuth(credential)).apiKey, credential.access);
  } finally { provider.shutdown(); }
});

test("thinking redaction clears only the final thinking and keeps the raw stream length stop", async () => {
  const fixture = await providerFixture({ chat: (request) => {
    assert.equal(request.body.chatModelUid, "swe-2-medium");
    assert.equal((request.body.configuration as JsonObject).maxTokens, "5");
    return streamResponse([{ deltaThinking: "hidden thought", deltaText: "visible" }, { thinkingRedacted: true }, { stopReason: "STOP_REASON_MAX_TOKENS" }]);
  } });
  try {
    const result = await fixture.provider.stream(fixture.model, context(), { apiKey: providerCredential.sessionToken, maxTokens: 5 }).result();
    assert.equal(result.stopReason, "length"); assert.equal(JSON.stringify(result).includes("hidden thought"), false);
    assert.equal(result.content.find((block) => block.type === "text")?.text, "visible");
  } finally { fixture.provider.shutdown(); }
});
