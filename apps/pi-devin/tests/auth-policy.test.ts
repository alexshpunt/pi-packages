import { Effect } from "effect";
import { expect, test } from "vitest";
import { runConversation } from "../src/cli/conversation.ts";
import { initializeClient } from "../src/cli/initialization.ts";
import { addTool } from "../src/cli/registered-tools.ts";
import { createSession } from "../src/cli/services/sessions.ts";
import { failureDetails, isAuthenticationError, RPCError } from "../src/core/errors.ts";
import type { ConnectClient } from "../src/core/protocol/connect-client.ts";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import {
  collect, connectClient, credential, devinClient, encodeResponse, errorStreamResponse, fingerprint, frameBytes, iterate, model, modelResponse, requestBody,
  run, runSync, settle, STATUS_METHOD, MODELS_METHOD, statusResponse, streamResponse, unaryResponse,
} from "./helpers.ts";

const local = { ...credential, apiServerURL: "http://127.0.0.1:9001" };
const requiresLogin = (error: unknown) => isAuthenticationError(error) && error.message.includes("login");

const consume = (client: ConnectClient, body = {}) => collect(client.stream(CHAT_METHOD, body));

test("a 401 on the initial status call blocks later calls and is kept apart from a new client", async () => {
  let calls = 0;
  const client = devinClient(local, { fingerprint: fingerprint(), fetch: async () => {
    calls++; return Response.json({}, { status: 401 });
  } });
  await expect(run(initializeClient(client))).rejects.toThrow(expect.toSatisfy(requiresLogin));
  expect(runSync(client.transport.isAuthenticationInvalid)).toBe(true);
  await expect(run(client.models)).rejects.toThrow(expect.toSatisfy(requiresLogin));
  await expect(run(client.status())).rejects.toThrow(expect.toSatisfy(requiresLogin));
  expect(calls).toBe(1);
  const fresh = devinClient(local, { fingerprint: fingerprint(), fetch: async () => unaryResponse(STATUS_METHOD, statusResponse()) });
  expect((await run(fresh.status())).canUseCli).toBe(true);
  expect(runSync(fresh.transport.isAuthenticationInvalid)).toBe(false);
});

for (const failingPath of [
  "/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings",
  "/exa.api_server_pb.ApiServerService/GetAccountManagedPlugins",
  "/v3/self", "/v3/organizations/offline-org/integrations",
]) test(`a 401 on an initialization helper call is not swallowed as a warning: ${failingPath}`, async () => {
  const paths: string[] = [];
  const client = devinClient(local, { fingerprint: fingerprint(), fetch: async (url) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path === failingPath) return Response.json({}, { status: 401 });
    if (path.startsWith("/v3/")) return Response.json({});
    const method = path.slice(1);
    return unaryResponse(method, method === STATUS_METHOD ? statusResponse(local.apiServerURL) : method === MODELS_METHOD ? modelResponse() : {});
  } });
  await expect(run(initializeClient(client))).rejects.toThrow(expect.toSatisfy(requiresLogin));
  expect(paths.at(-1)).toBe(failingPath);
  expect(runSync(client.transport.isAuthenticationInvalid)).toBe(true);
  const count = paths.length;
  await expect(run(client.models)).rejects.toThrow(expect.toSatisfy(requiresLogin));
  expect(paths.length).toBe(count);
});

test("a 401 header alone does not wait for an endless error body", { timeout: 1000 }, async () => {
  let isCancelled = false;
  const client = connectClient({ baseURL: local.apiServerURL, token: "offline-secret", timeoutMs: 100,
    fetch: async () => new Response(new ReadableStream({ cancel() { isCancelled = true; return new Promise(() => {}); } }), { status: 401 }),
  });
  await expect(run(client.unary(STATUS_METHOD, {}))).rejects.toThrow(expect.toSatisfy(requiresLogin));
  expect(isCancelled).toBe(true);
  expect(runSync(client.isAuthenticationInvalid)).toBe(true);
});

test("Unauthenticated in a partial stream asks for re-login and blocks follow-up requests", async () => {
  const token = "offline-authentication-secret";
  let calls = 0;
  const client = connectClient({ baseURL: local.apiServerURL, token, fetch: async () => {
    calls++; return errorStreamResponse("unauthenticated", token, [{ deltaText: "partial" }]);
  } });
  const stream = iterate(client.stream(CHAT_METHOD, {}));
  expect((await stream.next()).value?.data.deltaText).toBe("partial");
  await expect(stream.next()).rejects.toThrow(expect.toSatisfy((error: unknown) => {
    expect(requiresLogin(error)).toBeTruthy();
    expect((error as Error).message.includes(token)).toBeFalsy();
    expect(failureDetails(error)).toStrictEqual({ category: "authentication", code: "unauthenticated", requiresLogin: true });
    return true;
  }));
  await expect(consume(client)).rejects.toThrow(expect.toSatisfy(requiresLogin));
  expect(calls).toBe(1);
});

test("an auth failure in another call also stops an uncooperative stream in progress", { timeout: 1000 }, async () => {
  let isCancelled = false; let calls = 0;
  const client = connectClient({ baseURL: local.apiServerURL, token: "offline-secret", fetch: async (_url, init) => {
    calls++;
    if (init?.method === "GET") return Response.json({}, { status: 401 });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(frameBytes(encodeResponse({ deltaText: "partial" }))); },
      cancel() { isCancelled = true; },
    }), { headers: { "content-type": "application/connect+proto" } });
  } });
  const stream = iterate(client.stream(CHAT_METHOD, {}));
  await stream.next();
  const rejected = expect(stream.next()).rejects.toThrow(expect.toSatisfy(requiresLogin));
  await expect(run(client.getJSON(local.apiServerURL, "/v3/self"))).rejects.toThrow(expect.toSatisfy(requiresLogin));
  await rejected;
  expect(isCancelled).toBe(true);
  expect(calls).toBe(2);
});

test("after a 401 on the title request, already received tool calls are not executed", async () => {
  let resolveTitle!: (response: Response) => void;
  let toolExecutions = 0;
  const requests: unknown[] = [];
  const client = devinClient(local, { fingerprint: fingerprint(), fetch: async (_url, init) => {
    const body = requestBody(CHAT_METHOD, init!); requests.push(body.chatModelUid);
    if (body.chatModelUid === "swe-1-6-fast") return new Promise<Response>((resolve) => { resolveTitle = resolve; });
    return streamResponse([{ deltaToolCalls: [{ id: "not-executed", name: "add", argumentsJson: '{"a":1,"b":2}' }] }, { stopReason: "STOP_REASON_FUNCTION_CALL" }]);
  } });
  await expect(run(runConversation(client, createSession(model.id), [model], {
    prompt: "add numbers", onResult: () => Effect.sync(() => resolveTitle(Response.json({}, { status: 401 }))),
    tools: [{ ...addTool, execute: () => Effect.sync(() => { toolExecutions++; return "3"; }) }],
  }))).rejects.toThrow(expect.toSatisfy(requiresLogin));
  expect(toolExecutions).toBe(0);
  expect(requests).toStrictEqual([model.id, "swe-1-6-fast"]);
});

for (const [status, kind] of [[403, "permission"], [429, "rate_limit"], [500, "rpc"]] as const) {
  test(`HTTP ${status} does not invalidate authentication even with a contradicting body`, async () => {
    let calls = 0;
    const client = connectClient({ baseURL: local.apiServerURL, token: "offline-secret", fetch: async () => {
      calls++;
      return calls === 1 ? Response.json({ code: "unauthenticated", message: "not an authentication status" }, { status, headers: { "retry-after": "2" } })
        : unaryResponse(STATUS_METHOD, statusResponse());
    } });
    await expect(run(client.unary(STATUS_METHOD, {}))).rejects.toThrow(expect.toSatisfy((error: unknown) => {
      expect(error instanceof RPCError).toBeTruthy(); if (!(error instanceof RPCError)) throw new Error("unreachable"); expect(error.kind).toBe(kind);
      expect(error.retryAfterMs).toBe(status === 429 ? 2000 : undefined);
      expect(failureDetails(error).requiresLogin).toBe(undefined);
      return true;
    }));
    expect(calls).toBe(1);
    expect(runSync(client.isAuthenticationInvalid)).toBe(false);
    await run(client.unary(STATUS_METHOD, {}));
    expect(calls).toBe(2);
  });
}

for (const [code, kind] of [["permission_denied", "permission"], ["resource_exhausted", "rate_limit"], ["deadline_exceeded", "timeout"]] as const) {
  test(`EndStream ${code} is not an auth failure and a compressed request is not retried`, async () => {
    let calls = 0;
    const client = connectClient({ baseURL: local.apiServerURL, token: "offline-secret", fetch: async () => {
      calls++; return errorStreamResponse(code, "offline error");
    } });
    await expect(consume(client, { prompt: "x".repeat(9000) })).rejects.toThrow(expect.toSatisfy((error: unknown) => error instanceof RPCError && error.kind === kind));
    expect(runSync(client.isAuthenticationInvalid)).toBe(false);
    expect(calls).toBe(1);
  });
}

test("a connection failure leads to neither auth invalidation nor automatic retry", async () => {
  let calls = 0;
  const client = connectClient({ baseURL: local.apiServerURL, token: "offline-secret", fetch: async () => {
    calls++; throw Object.assign(new Error("offline connection reset"), { code: "ECONNRESET" });
  } });
  await expect(run(client.unary(STATUS_METHOD, {}))).rejects.toThrow(expect.toSatisfy((error: unknown) => {
    expect(failureDetails(error)).toStrictEqual({ category: "network", code: "ECONNRESET" }); return true;
  }));
  expect(calls).toBe(1);
  expect(runSync(client.isAuthenticationInvalid)).toBe(false);
});

test("HTTP 429 Retry-After dates or bad values are only hints and trigger no automatic retry", async () => {
  for (const header of ["2", new Date(Date.now() + 30_000).toUTCString(), "invalid", "-1", "1.5", "999999999999999999999999"]) {
    let calls = 0;
    const client = connectClient({ baseURL: local.apiServerURL, fetch: async () => {
      calls++; return Response.json({}, { status: 429, headers: { "retry-after": header } });
    } });
    await expect(consume(client, { prompt: "x".repeat(9000) })).rejects.toThrow(expect.toSatisfy((error: unknown) => {
      expect(error instanceof RPCError).toBeTruthy(); if (!(error instanceof RPCError)) throw new Error("unreachable"); expect(error.kind).toBe("rate_limit");
      if (header === "2") expect(error.retryAfterMs).toBe(2000);
      else if (header.includes("GMT")) expect(error.retryAfterMs! > 0 && error.retryAfterMs! <= 30_000).toBeTruthy();
      else expect(error.retryAfterMs).toBe(undefined);
      return true;
    }));
    expect(calls).toBe(1);
  }
});

for (const operation of ["unary", "stream", "rest"] as const) test(`the pre-response timeout also applies to an uncooperative ${operation} fetch`, { timeout: 1000 }, async () => {
  let resolveResponse!: (response: Response) => void;
  let isLateBodyCancelled = false;
  const client = connectClient({ baseURL: local.apiServerURL, timeoutMs: 30,
    fetch: () => new Promise<Response>((resolve) => { resolveResponse = resolve; }),
  });
  const pending = operation === "unary" ? run(client.unary(STATUS_METHOD, {})) : operation === "stream" ? consume(client) : run(client.getJSON(local.apiServerURL, "/v3/self"));
  await expect(pending).rejects.toThrow(expect.toSatisfy((error: Error) => error.name === "TimeoutError"));
  expect(runSync(client.isAuthenticationInvalid)).toBe(false);
  resolveResponse(new Response(new ReadableStream({ cancel() { isLateBodyCancelled = true; } })));
  await Promise.resolve();
  expect(isLateBodyCancelled).toBe(true);
});

test("a response body timeout and an endless cancel still end within the overall deadline", { timeout: 1000 }, async () => {
  for (const isEarlyReturn of [false, true]) {
    let isCancelled = false;
    const client = connectClient({ baseURL: local.apiServerURL, timeoutMs: 30, fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(frameBytes(encodeResponse({ deltaText: "partial" }))); },
      cancel() { isCancelled = true; return new Promise(() => {}); },
    }), { headers: { "content-type": "application/connect+proto" } }) });
    const stream = iterate(client.stream(CHAT_METHOD, {}));
    await stream.next();
    // An early return releases the body at once; continuing to read ends with the deadline.
    if (isEarlyReturn) await stream.return!(undefined);
    else await expect(stream.next()).rejects.toThrow(expect.toSatisfy((error: Error) => error.name === "TimeoutError"));
    expect(isCancelled).toBe(true);
  }
});

test("the 415 resend shares the same overall deadline and caller cancel signal", { timeout: 1000 }, async () => {
  const signals: AbortSignal[] = [];
  const caller = new AbortController();
  const startedAt = performance.now();
  const client = connectClient({ baseURL: local.apiServerURL, timeoutMs: 60, fetch: async (_url, init) => {
    signals.push(init!.signal!);
    if (signals.length === 1) { await new Promise((resolve) => setTimeout(resolve, 15)); return Response.json({}, { status: 415 }); }
    return new Promise<Response>(() => {});
  } });
  await expect(collect(client.stream(CHAT_METHOD, { prompt: "x".repeat(9000) }), caller.signal)).rejects.toThrow(expect.toSatisfy((error: Error) => error.name === "TimeoutError"));
  // One deadline covers both attempts: the resend does not restart the 60ms timer.
  expect(performance.now() - startedAt).toBeLessThan(120);
  expect(signals.length).toBe(2);
  expect(signals[1].aborted).toBe(true);
  expect(caller.signal.aborted).toBe(false);
  // The caller's cancellation reaches the resend too, with the caller's reason.
  const resent: AbortSignal[] = [];
  const cancelling = new AbortController();
  const cancelled = connectClient({ baseURL: local.apiServerURL, timeoutMs: 5000, fetch: async (_url, init) => {
    resent.push(init!.signal!);
    if (resent.length === 1) return Response.json({}, { status: 415 });
    cancelling.abort(new DOMException("caller stop", "AbortError"));
    return new Promise<Response>(() => {});
  } });
  await expect(collect(cancelled.stream(CHAT_METHOD, { prompt: "x".repeat(9000) }), cancelling.signal))
    .rejects.toThrow(expect.toSatisfy((error: Error) => error.name === "AbortError" && error.message === "caller stop"));
  expect(resent.length).toBe(2);
  expect(resent[1].aborted).toBe(true);
});

test("caller cancellation is not overwritten by a timeout and the timer of a finished request is released", async () => {
  const caller = new AbortController();
  const cancelled = connectClient({ baseURL: local.apiServerURL, timeoutMs: 5000, fetch: () => new Promise<Response>(() => {}) });
  const pending = run(cancelled.unary(STATUS_METHOD, {}), caller.signal);
  caller.abort(new DOMException("caller stop", "AbortError"));
  await expect(pending).rejects.toThrow(expect.toSatisfy((error: Error) => error.name === "AbortError" && error.message === "caller stop"));
  let receivedSignal!: AbortSignal;
  const completed = connectClient({ baseURL: local.apiServerURL, timeoutMs: 30, fetch: async (_url, init) => {
    receivedSignal = init!.signal!; return unaryResponse(STATUS_METHOD, statusResponse());
  } });
  await run(completed.unary(STATUS_METHOD, {}));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await settle();
  expect(receivedSignal.aborted).toBe(false);
});
