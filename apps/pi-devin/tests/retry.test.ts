import { expect, test, vi } from "vitest";
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
    expect(inferenceRetryDelayMs(index, 0)).toBe(1000 * 2 ** index);
    expect(inferenceRetryDelayMs(index, 0.5)).toBe(2000 * 2 ** index);
    expect(inferenceRetryDelayMs(index, 1 - Number.EPSILON)).toBe(3000 * 2 ** index);
  }
  for (const random of [-1, 1, NaN, Infinity]) expect(() => inferenceRetryDelayMs(0, random)).toThrow();
  expect(() => inferenceRetryDelayMs(4, 0.5)).toThrow();
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
  await expect(runConversation(client, state, [model], { prompt: "offline", generateTitle: false, retryRuntime: retry.runtime })).rejects.toThrow(expect.toSatisfy((error: unknown) => error instanceof RPCError && error.kind === "rate_limit" && error.retryAfterMs === 120000));
  expect(requests.length).toBe(15);
  expect(state.nextStepIndex).toBe(15);
  expect(state.messages.length).toBe(1);
  expect(retry.waits).toStrictEqual(Array.from({ length: 3 }, () => [2000, 4000, 8000, 16000]).flat());
  expect(new Set(traces).size).toBe(15);
  expect(new Set(requests.map((request) => object(request.metadata, "metadata").f)).size).toBe(15);
  expect(new Set(requests.map((request) => (request.chatMessagePrompts as JsonObject[])[0].messageId)).size).toBe(15);
  for (const [index, request] of requests.entries()) {
    expect(request.executionId).toBe(requests[0].executionId);
    expect(request.cascadeId).toBe(requests[0].cascadeId);
    expect(request.clientSessionId).toBe(state.id);
    expect(request.chatModelUid).toBe(model.id);
    const trajectory = object(request.trajectoryReference, "trajectory");
    expect(trajectory.stepIndex ?? 0).toBe(index);
    expect(trajectory.stepType).toBe(index < 5 ? "CORTEX_STEP_TYPE_USER_INPUT" : undefined);
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
    await expect(runConversation(client, state, [model], { prompt: "offline", generateTitle: false,
      retryRuntime: retry.runtime, onText: (delta) => deltas.push(delta) })).rejects.toThrow(expect.toSatisfy((error: unknown) => error instanceof RPCError && error.code === code));
    expect(requests.length).toBe(3); expect(retry.waits).toStrictEqual([]);
    expect(deltas).toStrictEqual(["PARTIAL", "PARTIAL", "PARTIAL"]);
    expect(state.messages.length).toBe(1);
    expect(requests.map((request) => object(request.trajectoryReference, "trajectory").stepType)).toStrictEqual(["CORTEX_STEP_TYPE_USER_INPUT", undefined, undefined]);
    client.transport.close();
  });
}

for (const status of [401, 403]) test(`HTTP ${status} is not recovered`, async () => {
  let calls = 0;
  const retry = virtualRetry();
  const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async () => { calls++; return Response.json({}, { status }); } });
  await expect(runConversation(client, createSession(model.id), [model], { prompt: "offline", generateTitle: false, retryRuntime: retry.runtime })).rejects.toThrow();
  expect(calls).toBe(1); expect(retry.waits).toStrictEqual([]);
  client.transport.close();
});

test("local timeouts and call budget errors are not retried", async () => {
  for (const error of [new DOMException("explicit deadline", "TimeoutError"), new Error("budget exhausted")]) {
    let calls = 0;
    const retry = virtualRetry();
    await expect(withInferenceRetries(async () => { calls++; throw error; }, { signal: new AbortController().signal, runtime: retry.runtime })).rejects.toThrow(expect.toSatisfy((received: unknown) => received === error));
    expect(calls).toBe(1); expect(retry.waits).toStrictEqual([]);
  }
});

test("no new request is sent beyond the per-attempt budget", async () => {
  let sent = 0;
  const retry = virtualRetry();
  const client = new DevinClient(credential, { fingerprint: fingerprint(),
    onRequest: () => { if (sent >= 2) throw new Error("budget exhausted"); },
    fetch: async () => { sent++; return rateLimit(); },
  });
  await expect(runConversation(client, createSession(model.id), [model], { prompt: "offline", generateTitle: false, retryRuntime: retry.runtime })).rejects.toThrow(/budget exhausted/);
  expect(sent).toBe(2); client.transport.close();
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
    await expect(runConversation(client, createSession(model.id), [model], { prompt: "offline", generateTitle: false,
      retryRuntime: runtime, signal: controller.signal })).rejects.toThrow(expect.toSatisfy((error: Error) => error.name === "AbortError"));
    expect(calls).toBe(1); client.transport.close();
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
  await expect(runConversation(client, createSession(model.id), [model], { prompt: "offline", retryRuntime: {
    wait: async () => { rejectTitle(); await new Promise(() => {}); },
  } })).rejects.toThrow(expect.toSatisfy((error: unknown) => error instanceof RPCError && error.kind === "authentication"));
  expect(main).toBe(1); expect(titles).toBe(1); client.transport.close();
});

test("the default 90000ms deadline ends the final fetch signal", { timeout: 1000 }, async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const captured: { signal?: AbortSignal | null } = {};
  const client = new ConnectClient({ baseURL: credential.apiServerURL, fetch: async (_url, init) => {
    captured.signal = init!.signal;
    return new Promise<Response>(() => {});
  } });
  try {
    const pending = client.unary("exa.seat_management_pb.SeatManagementService/GetUserStatus", {});
    const rejected = expect(pending).rejects.toThrow(expect.toSatisfy((error: Error) => error.name === "TimeoutError" && error.message.includes("90000ms")));
    expect(captured.signal).toBeTruthy(); if (!captured.signal) throw new Error("unreachable");
    vi.advanceTimersByTime(89_999);
    expect(captured.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(captured.signal.aborted).toBe(true);
    await rejected;
  } finally { client.close(); vi.useRealTimers(); }
});

test("the default wait applies the computed delay to the actual next request", async () => {
  const times: number[] = [];
  const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async () => {
    times.push(performance.now()); return times.length === 1 ? rateLimit() : streamResponse(finalFrames());
  } });
  const result = await runConversation(client, createSession(model.id), [model], { prompt: "offline", generateTitle: false, retryRuntime: { random: () => 0 } });
  expect(result.message.prompt).toBe("OK"); expect(times.length).toBe(2);
  expect(times[1] - times[0] >= 950, "the 1000ms wait must apply to the final send.").toBeTruthy();
  client.transport.close();
});
