import { expect, test, vi } from "vitest";
import { normalizeContext, type OAuthCredential } from "@earendil-works/pi-ai";
import { makeTestProvider } from "./extension-harness.ts";
import type { JsonObject } from "../src/core/types.ts";
import { encodeResponse, finalFrames, frameBytes, runSync, STATUS_METHOD, streamResponse } from "./helpers.ts";
import { providerCredential, providerFixture, providerHostCredential } from "./provider-fixture.ts";

const context = () => normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 1 }] });
const options = { apiKey: providerCredential.sessionToken, reasoning: "high" as const };
/** Resolves to undefined long before a request blocked on a never-settling cleanup could end. Effect fibers take a few event-loop turns. */
const hangGuard = () => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1_000));
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test("the body is not read before onResponse completes and the payload UID replacement is kept", async () => {
  let hasObservedResponse = false, reads = 0;
  const fixture = await providerFixture({ chat: (request) => {
    expect(request.body.chatModelUid).toBe("swe-2-max");
    const bytes = Buffer.concat([...finalFrames("replacement").map((frame) => frameBytes(encodeResponse(frame))), frameBytes(Buffer.from("{}"), 2)]);
    return new Response(new ReadableStream({ pull(controller) { expect(hasObservedResponse).toBe(true); reads++; controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 }), { headers: { "content-type": "application/connect+proto" } });
  } });
  try {
    const result = await fixture.provider.streamSimple(fixture.model, context(), { ...options,
      onPayload: (payload) => ({ ...(payload as JsonObject), chatModelUid: "swe-2-max" }),
      onResponse: async () => { expect(reads).toBe(0); await Promise.resolve(); hasObservedResponse = true; },
    }).result();
    expect(result.stopReason, result.errorMessage ?? "").toBe("stop"); expect(result.providerThinkingLevel).toBe("swe-2-max"); expect(reads).toBe(1);
  } finally { fixture.shutdown(); }
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
    const result = await Promise.race([stream.result(), hangGuard()]);
    expect(result, "an uncooperative cleanup blocked the response from ending").toBeTruthy(); if (!result) throw new Error("unreachable"); expect(result.stopReason).toBe("error"); expect(cancels).toBe(1);
    const serialized = JSON.stringify(result);
    for (const secret of [providerCredential.sessionToken, fingerprint, "fake-sensitive-header"]) expect(serialized.includes(secret)).toBe(false);
  } finally { fixture.shutdown(); }
});

test("a frame observer failure stops the open reader and does not wait for an uncooperative cancel", async () => {
  let sent = false, cancels = 0;
  const fixture = await providerFixture({ chat: () => new Response(new ReadableStream({
    pull(controller) { if (!sent) { sent = true; controller.enqueue(frameBytes(encodeResponse({ deltaText: "partial" }))); } },
    cancel() { cancels++; return new Promise(() => {}); },
  }, { highWaterMark: 0 })) });
  try {
    const stream = fixture.provider.streamSimple(fixture.model, context(), { ...options, onProviderStreamEvent: () => { throw new Error("observer failed"); } });
    const result = await Promise.race([stream.result(), hangGuard()]);
    expect(result).toBeTruthy(); if (!result) throw new Error("unreachable"); expect(result.stopReason).toBe("error"); expect(cancels).toBe(1);
  } finally { fixture.shutdown(); }
});

test("even an uncooperative payload hook ends within the RPC deadline", async (context) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); context.onTestFinished(() => { vi.useRealTimers(); }); const fixture = await providerFixture();
  try {
    const result = await fixture.provider.streamSimple(fixture.model, normalizeContext({ messages: [] }), { ...options, timeoutMs: 5000,
      onPayload: () => { vi.advanceTimersByTime(5000); return new Promise(() => {}); },
    }).result();
    expect(result.stopReason).toBe("error"); expect(result.errorMessage!).toMatch(/5000/); expect(fixture.chatCalls()).toBe(0);
  } finally { fixture.shutdown(); }
});

test("server redaction clears the final text/thinking/tool payload and does not turn failure into success", async () => {
  const fixture = await providerFixture({ chat: () => streamResponse([
    { deltaText: "private text", deltaThinking: "private thought", deltaSignature: "private signature", deltaToolCalls: [{ id: "call", name: "tool", argumentsJson: '{"private":true}' }] },
    { redact: true },
  ]) });
  try {
    const result = await fixture.provider.streamSimple(fixture.model, context(), options).result();
    expect(result.stopReason).toBe("error"); expect(JSON.stringify(result).includes("private")).toBe(false);
  } finally { fixture.shutdown(); }
});

test("a 401 blocks waiting requests of the same run and later direct calls", async () => {
  const started = gate<void>(), response = gate<Response>();
  const fixture = await providerFixture({ chat: () => { started.resolve(); return response.promise; } });
  runSync(fixture.runs.begin("agent"));
  try {
    const first = fixture.provider.streamSimple(fixture.model, context(), options), second = fixture.provider.streamSimple(fixture.model, context(), options);
    await started.promise; response.resolve(Response.json({}, { status: 401 }));
    const results = await Promise.all([first.result(), second.result()]);
    expect(results.every((result) => result.stopReason === "error")).toBe(true); expect(fixture.chatCalls()).toBe(1);
    runSync(fixture.runs.finish); runSync(fixture.runs.begin("agent"));
    const before = fixture.requests.length;
    const rejected = await fixture.provider.streamSimple(fixture.model, context(), options).result();
    expect(rejected.stopReason).toBe("error"); expect(rejected.errorMessage!).toMatch(/login/); expect(fixture.requests.length).toBe(before);
  } finally { fixture.shutdown(); }
});

test("a late 401 from an older auth generation does not cancel runs after a new login", async () => {
  const f = await providerFixture(); f.shutdown();
  const statusStarted = gate<void>(), oldStatus = gate<Response>(), chatStarted = gate<void>(), chatResponse = gate<Response>();
  let statusCalls = 0, chatSignal!: AbortSignal;
  const late = makeTestProvider({ ...f.dependencies, fetch: async (url, init) => {
    if (String(url).endsWith(STATUS_METHOD) && ++statusCalls === 1) { statusStarted.resolve(); return oldStatus.promise; }
    if (String(url).endsWith("/GetChatMessage")) { chatSignal = init!.signal!; chatStarted.resolve(); return chatResponse.promise; }
    return f.dependencies.fetch(url, init);
  } });
  const { provider } = late;
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
    const rejection = expect(refresh).rejects.toThrow(/authentication|401/); oldStatus.resolve(Response.json({}, { status: 401 })); await rejection;
    expect(chatSignal.aborted).toBe(false);
    chatResponse.resolve(streamResponse(finalFrames()));
    expect((await stream.result()).stopReason).toBe("stop");
    expect((await provider.auth.oauth!.toAuth(credential)).apiKey).toBe(credential.access);
  } finally { late.shutdown(); }
});

test("thinking redaction clears only the final thinking and keeps the raw stream length stop", async () => {
  const fixture = await providerFixture({ chat: (request) => {
    expect(request.body.chatModelUid).toBe("swe-2-medium");
    expect((request.body.configuration as JsonObject).maxTokens).toBe("5");
    return streamResponse([{ deltaThinking: "hidden thought", deltaText: "visible" }, { thinkingRedacted: true }, { stopReason: "STOP_REASON_MAX_TOKENS" }]);
  } });
  try {
    const result = await fixture.provider.stream(fixture.model, context(), { apiKey: providerCredential.sessionToken, maxTokens: 5 }).result();
    expect(result.stopReason).toBe("length"); expect(JSON.stringify(result).includes("hidden thought")).toBe(false);
    expect(result.content.find((block) => block.type === "text")?.text).toBe("visible");
  } finally { fixture.shutdown(); }
});
