import assert from "node:assert/strict";
import { test } from "node:test";
import { runConversation } from "../src/cli/conversation.ts";
import { DevinClient } from "../src/core/client.ts";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import { inferenceRetryDelayMs, withInferenceRetries, type InferenceRetryRuntime } from "../src/core/inference/retry.ts";
import { createSession } from "../src/cli/session-store.ts";
import { ConnectClient, RPCError } from "../src/core/protocol/transport.ts";
import { object, type JsonObject } from "../src/core/types.ts";
import { credential, errorStreamResponse, finalFrames, fingerprint, model, requestBody, streamResponse } from "./helpers.ts";

function virtualRetry() {
  const waits: number[] = [];
  const runtime: InferenceRetryRuntime = {
    random: () => 0.5,
    wait: async (delayMs, signal) => { signal.throwIfAborted(); waits.push(delayMs); },
  };
  return { waits, runtime };
}

const rateLimit = () => Response.json({ code: "resource_exhausted", message: "offline simulated error" }, {
  status: 429, headers: { "retry-after": "120" },
});

test("computes the native backoff start, multiplier and jitter", () => {
  for (let index = 0; index < 4; index++) {
    assert.equal(inferenceRetryDelayMs(index, 0), 1000 * 2 ** index);
    assert.equal(inferenceRetryDelayMs(index, 0.5), 2000 * 2 ** index);
    assert.equal(inferenceRetryDelayMs(index, 1 - Number.EPSILON), 3000 * 2 ** index);
  }
  for (const random of [-1, 1, NaN, Infinity]) assert.throws(() => inferenceRetryDelayMs(0, random));
  assert.throws(() => inferenceRetryDelayMs(4, 0.5));
});

test("429 retries 5×3 times, each final send with a new fingerprint, trace, message ID and a higher step", async () => {
  const requests: JsonObject[] = [];
  const traces: string[] = [];
  const retry = virtualRetry();
  const client = new DevinClient(credential, { fingerprint: fingerprint(), compressionThresholdBytes: 1, fetch: async (_url, init) => {
    requests.push(requestBody(CHAT_METHOD, init!)); traces.push(new Headers(init!.headers).get("sentry-trace")!);
    return rateLimit();
  } });
  const state = createSession(model.id);
  await assert.rejects(runConversation(client, state, [model], { prompt: "offline", generateTitle: false, retryRuntime: retry.runtime }),
    (error: unknown) => error instanceof RPCError && error.kind === "rate_limit" && error.retryAfterMs === 120000);
  assert.equal(requests.length, 15);
  assert.equal(state.nextStepIndex, 15);
  assert.equal(state.messages.length, 1);
  assert.deepEqual(retry.waits, Array.from({ length: 3 }, () => [2000, 4000, 8000, 16000]).flat());
  assert.equal(new Set(traces).size, 15);
  assert.equal(new Set(requests.map((request) => object(request.metadata, "metadata").f)).size, 15);
  assert.equal(new Set(requests.map((request) => (request.chatMessagePrompts as JsonObject[])[0].messageId)).size, 15);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.executionId, requests[0].executionId);
    assert.equal(request.cascadeId, requests[0].cascadeId);
    assert.equal(request.clientSessionId, state.id);
    assert.equal(request.chatModelUid, model.id);
    const trajectory = object(request.trajectoryReference, "trajectory");
    assert.equal(trajectory.stepIndex ?? 0, index);
    assert.equal(trajectory.stepType, index < 5 ? "CORTEX_STEP_TYPE_USER_INPUT" : undefined);
  }
  client.transport.close();
});

for (const code of ["resource_exhausted", "deadline_exceeded", "internal", "unavailable"]) {
  test(`Connect ${code} recovers 3 times and failed partial responses or tools never enter the run history`, async () => {
    const requests: JsonObject[] = [];
    const deltas: string[] = [];
    const retry = virtualRetry();
    const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async (_url, init) => {
      requests.push(requestBody(CHAT_METHOD, init!));
      return errorStreamResponse(code, "offline", [{ deltaText: "PARTIAL", deltaToolCalls: [{ id: "pending", name: "not-registered", argumentsJson: "{}" }] }]);
    } });
    const state = createSession(model.id);
    await assert.rejects(runConversation(client, state, [model], { prompt: "offline", generateTitle: false,
      retryRuntime: retry.runtime, onText: (delta) => deltas.push(delta) }), (error: unknown) => error instanceof RPCError && error.code === code);
    assert.equal(requests.length, 3); assert.deepEqual(retry.waits, []);
    assert.deepEqual(deltas, ["PARTIAL", "PARTIAL", "PARTIAL"]);
    assert.equal(state.messages.length, 1);
    assert.deepEqual(requests.map((request) => object(request.trajectoryReference, "trajectory").stepType), ["CORTEX_STEP_TYPE_USER_INPUT", undefined, undefined]);
    client.transport.close();
  });
}

for (const status of [401, 403]) test(`HTTP ${status} is not recovered`, async () => {
  let calls = 0;
  const retry = virtualRetry();
  const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async () => { calls++; return Response.json({}, { status }); } });
  await assert.rejects(runConversation(client, createSession(model.id), [model], { prompt: "offline", generateTitle: false, retryRuntime: retry.runtime }));
  assert.equal(calls, 1); assert.deepEqual(retry.waits, []);
  client.transport.close();
});

test("local timeouts and call budget errors are not retried", async () => {
  for (const error of [new DOMException("explicit deadline", "TimeoutError"), new Error("budget exhausted")]) {
    let calls = 0;
    const retry = virtualRetry();
    await assert.rejects(withInferenceRetries(async () => { calls++; throw error; }, { signal: new AbortController().signal, runtime: retry.runtime }), (received: unknown) => received === error);
    assert.equal(calls, 1); assert.deepEqual(retry.waits, []);
  }
});

test("no new request is sent beyond the per-attempt budget", async () => {
  let sent = 0;
  const retry = virtualRetry();
  const client = new DevinClient(credential, { fingerprint: fingerprint(),
    onRequest: () => { if (sent >= 2) throw new Error("budget exhausted"); },
    fetch: async () => { sent++; return rateLimit(); },
  });
  await assert.rejects(runConversation(client, createSession(model.id), [model], { prompt: "offline", generateTitle: false, retryRuntime: retry.runtime }), /budget exhausted/);
  assert.equal(sent, 2); client.transport.close();
});

test("a wait that ignores cancellation during retry is still stopped by the caller and client.close", async () => {
  for (const isCallerAbort of [true, false]) {
    let calls = 0;
    const controller = new AbortController();
    const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async () => { calls++; return rateLimit(); } });
    const runtime: InferenceRetryRuntime = { wait: () => {
      if (isCallerAbort) controller.abort(new DOMException("cancelled", "AbortError")); else client.transport.close();
      return new Promise(() => {});
    } };
    await assert.rejects(runConversation(client, createSession(model.id), [model], { prompt: "offline", generateTitle: false,
      retryRuntime: runtime, signal: controller.signal }), (error: Error) => error.name === "AbortError");
    assert.equal(calls, 1); client.transport.close();
  }
});

test("a title auth error wakes the main retry wait and blocks follow-up requests", async () => {
  let rejectTitle!: () => void;
  let main = 0, titles = 0;
  const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async (_url, init) => {
    const body = requestBody(CHAT_METHOD, init!);
    if (body.chatModelUid === "swe-1-6-fast") {
      titles++;
      return new Promise<Response>((resolve) => { rejectTitle = () => resolve(Response.json({}, { status: 401 })); });
    }
    main++; return rateLimit();
  } });
  await assert.rejects(runConversation(client, createSession(model.id), [model], { prompt: "offline", retryRuntime: {
    wait: async () => { rejectTitle(); await new Promise(() => {}); },
  } }), (error: unknown) => error instanceof RPCError && error.kind === "authentication");
  assert.equal(main, 1); assert.equal(titles, 1); client.transport.close();
});

test("the default 90000ms deadline ends the final fetch signal", { timeout: 1000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const captured: { signal?: AbortSignal | null } = {};
  const client = new ConnectClient({ baseURL: credential.apiServerURL, fetch: async (_url, init) => {
    captured.signal = init!.signal;
    return new Promise<Response>(() => {});
  } });
  try {
    const pending = client.unary("exa.seat_management_pb.SeatManagementService/GetUserStatus", {});
    const rejected = assert.rejects(pending, (error: Error) => error.name === "TimeoutError" && error.message.includes("90000ms"));
    assert.ok(captured.signal);
    t.mock.timers.tick(89_999);
    assert.equal(captured.signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(captured.signal.aborted, true);
    await rejected;
  } finally { client.close(); t.mock.timers.reset(); }
});

test("the default wait applies the computed delay to the actual next request", async () => {
  const times: number[] = [];
  const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async () => {
    times.push(performance.now()); return times.length === 1 ? rateLimit() : streamResponse(finalFrames());
  } });
  const result = await runConversation(client, createSession(model.id), [model], { prompt: "offline", generateTitle: false, retryRuntime: { random: () => 0 } });
  assert.equal(result.message.prompt, "OK"); assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 950, "the 1000ms wait must apply to the final send.");
  client.transport.close();
});
