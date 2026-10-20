import assert from "node:assert/strict";
import { test } from "node:test";
import { runConversation } from "../src/cli/conversation.ts";
import { DevinClient } from "../src/core/client.ts";
import { initializeClient } from "../src/cli/initialization.ts";
import { CHAT_METHOD, chatResponseCodec } from "../src/core/protocol/protobuf.ts";
import { createSession } from "../src/cli/session-store.ts";
import { addTool } from "../src/cli/registered-tools.ts";
import { ConnectClient, encodeFrame, failureDetails, isAuthenticationError, RPCError } from "../src/core/protocol/transport.ts";
import {
  credential, errorStreamResponse, fingerprint, model, modelResponse, requestBody,
  STATUS_METHOD, MODELS_METHOD, statusResponse, streamResponse, unaryResponse,
} from "./helpers.ts";

const local = { ...credential, apiServerURL: "http://127.0.0.1:9001" };
const requiresLogin = (error: unknown) => isAuthenticationError(error) && error.message.includes("login");

async function consume(client: ConnectClient, body = {}): Promise<void> {
  for await (const _frame of client.stream(CHAT_METHOD, body)) {}
}

test("a 401 on the initial status call blocks later calls and is kept apart from a new client", async () => {
  let calls = 0;
  const client = new DevinClient(local, { fingerprint: fingerprint(), fetch: async () => {
    calls++; return Response.json({}, { status: 401 });
  } });
  await assert.rejects(initializeClient(client), requiresLogin);
  assert.equal(client.transport.isAuthenticationInvalid, true);
  await assert.rejects(client.models(), requiresLogin);
  await assert.rejects(client.status(), requiresLogin);
  assert.equal(calls, 1);
  const fresh = new DevinClient(local, { fingerprint: fingerprint(), fetch: async () => unaryResponse(STATUS_METHOD, statusResponse()) });
  assert.equal((await fresh.status()).canUseCli, true);
  assert.equal(fresh.transport.isAuthenticationInvalid, false);
});

for (const failingPath of [
  "/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings",
  "/exa.api_server_pb.ApiServerService/GetAccountManagedPlugins",
  "/v3/self", "/v3/organizations/offline-org/integrations",
]) test(`a 401 on an initialization helper call is not swallowed as a warning: ${failingPath}`, async () => {
  const paths: string[] = [];
  const client = new DevinClient(local, { fingerprint: fingerprint(), fetch: async (url) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path === failingPath) return Response.json({}, { status: 401 });
    if (path.startsWith("/v3/")) return Response.json({});
    const method = path.slice(1);
    return unaryResponse(method, method === STATUS_METHOD ? statusResponse(local.apiServerURL) : method === MODELS_METHOD ? modelResponse() : {});
  } });
  await assert.rejects(initializeClient(client), requiresLogin);
  assert.equal(paths.at(-1), failingPath);
  assert.equal(client.transport.isAuthenticationInvalid, true);
  const count = paths.length;
  await assert.rejects(client.models(), requiresLogin);
  assert.equal(paths.length, count);
});

test("a 401 header alone does not wait for an endless error body", { timeout: 1000 }, async () => {
  let isCancelled = false;
  const client = new ConnectClient({ baseURL: local.apiServerURL, token: "offline-secret", timeoutMs: 100,
    fetch: async () => new Response(new ReadableStream({ cancel() { isCancelled = true; return new Promise(() => {}); } }), { status: 401 }),
  });
  await assert.rejects(client.unary(STATUS_METHOD, {}), requiresLogin);
  assert.equal(isCancelled, true);
  assert.equal(client.isAuthenticationInvalid, true);
});

test("Unauthenticated in a partial stream asks for re-login and blocks follow-up requests", async () => {
  const token = "offline-authentication-secret";
  let calls = 0;
  const client = new ConnectClient({ baseURL: local.apiServerURL, token, fetch: async () => {
    calls++; return errorStreamResponse("unauthenticated", token, [{ deltaText: "partial" }]);
  } });
  const stream = client.stream(CHAT_METHOD, {});
  assert.equal((await stream.next()).value?.data.deltaText, "partial");
  await assert.rejects(stream.next(), (error: unknown) => {
    assert.ok(requiresLogin(error));
    assert.ok(!(error as Error).message.includes(token));
    assert.deepEqual(failureDetails(error), { category: "authentication", code: "unauthenticated", requiresLogin: true });
    return true;
  });
  await assert.rejects(consume(client), requiresLogin);
  assert.equal(calls, 1);
});

test("an auth failure in another call also stops an uncooperative stream in progress", { timeout: 1000 }, async () => {
  let isCancelled = false; let calls = 0;
  const client = new ConnectClient({ baseURL: local.apiServerURL, token: "offline-secret", fetch: async (_url, init) => {
    calls++;
    if (init?.method === "GET") return Response.json({}, { status: 401 });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(encodeFrame(chatResponseCodec.encode({ deltaText: "partial" }))); },
      cancel() { isCancelled = true; },
    }), { headers: { "content-type": "application/connect+proto" } });
  } });
  const stream = client.stream(CHAT_METHOD, {});
  await stream.next();
  const rejected = assert.rejects(stream.next(), requiresLogin);
  await assert.rejects(client.getJSON(local.apiServerURL, "/v3/self"), requiresLogin);
  await rejected;
  assert.equal(isCancelled, true);
  assert.equal(calls, 2);
});

test("after a 401 on the title request, already received tool calls are not executed", async () => {
  let resolveTitle!: (response: Response) => void;
  let toolExecutions = 0;
  const requests: unknown[] = [];
  const client = new DevinClient(local, { fingerprint: fingerprint(), fetch: async (_url, init) => {
    const body = requestBody(CHAT_METHOD, init!); requests.push(body.chatModelUid);
    if (body.chatModelUid === "swe-1-6-fast") return new Promise<Response>((resolve) => { resolveTitle = resolve; });
    return streamResponse([{ deltaToolCalls: [{ id: "not-executed", name: "add", argumentsJson: '{"a":1,"b":2}' }] }, { stopReason: "STOP_REASON_FUNCTION_CALL" }]);
  } });
  await assert.rejects(runConversation(client, createSession(model.id), [model], {
    prompt: "add numbers", onResult: () => resolveTitle(Response.json({}, { status: 401 })),
    tools: [{ ...addTool, execute: async () => { toolExecutions++; return "3"; } }],
  }), requiresLogin);
  assert.equal(toolExecutions, 0);
  assert.deepEqual(requests, [model.id, "swe-1-6-fast"]);
});

for (const [status, kind] of [[403, "permission"], [429, "rate_limit"], [500, "rpc"]] as const) {
  test(`HTTP ${status} does not invalidate authentication even with a contradicting body`, async () => {
    let calls = 0;
    const client = new ConnectClient({ baseURL: local.apiServerURL, token: "offline-secret", fetch: async () => {
      calls++;
      return calls === 1 ? Response.json({ code: "unauthenticated", message: "not an authentication status" }, { status, headers: { "retry-after": "2" } })
        : unaryResponse(STATUS_METHOD, statusResponse());
    } });
    await assert.rejects(client.unary(STATUS_METHOD, {}), (error: unknown) => {
      assert.ok(error instanceof RPCError); assert.equal(error.kind, kind);
      assert.equal(error.retryAfterMs, status === 429 ? 2000 : undefined);
      assert.equal(failureDetails(error).requiresLogin, undefined);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(client.isAuthenticationInvalid, false);
    await client.unary(STATUS_METHOD, {});
    assert.equal(calls, 2);
  });
}

for (const [code, kind] of [["permission_denied", "permission"], ["resource_exhausted", "rate_limit"], ["deadline_exceeded", "timeout"]] as const) {
  test(`EndStream ${code} is not an auth failure and a compressed request is not retried`, async () => {
    let calls = 0;
    const client = new ConnectClient({ baseURL: local.apiServerURL, token: "offline-secret", fetch: async () => {
      calls++; return errorStreamResponse(code, "offline error");
    } });
    await assert.rejects(consume(client, { prompt: "x".repeat(9000) }), (error: unknown) => error instanceof RPCError && error.kind === kind);
    assert.equal(client.isAuthenticationInvalid, false);
    assert.equal(calls, 1);
  });
}

test("a connection failure leads to neither auth invalidation nor automatic retry", async () => {
  let calls = 0;
  const client = new ConnectClient({ baseURL: local.apiServerURL, token: "offline-secret", fetch: async () => {
    calls++; throw Object.assign(new Error("offline connection reset"), { code: "ECONNRESET" });
  } });
  await assert.rejects(client.unary(STATUS_METHOD, {}), (error: unknown) => {
    assert.deepEqual(failureDetails(error), { category: "network", code: "ECONNRESET" }); return true;
  });
  assert.equal(calls, 1);
  assert.equal(client.isAuthenticationInvalid, false);
});

test("HTTP 429 Retry-After dates or bad values are only hints and trigger no automatic retry", async () => {
  for (const header of ["2", new Date(Date.now() + 30_000).toUTCString(), "invalid", "-1", "1.5", "999999999999999999999999"]) {
    let calls = 0;
    const client = new ConnectClient({ baseURL: local.apiServerURL, fetch: async () => {
      calls++; return Response.json({}, { status: 429, headers: { "retry-after": header } });
    } });
    await assert.rejects(consume(client, { prompt: "x".repeat(9000) }), (error: unknown) => {
      assert.ok(error instanceof RPCError); assert.equal(error.kind, "rate_limit");
      if (header === "2") assert.equal(error.retryAfterMs, 2000);
      else if (header.includes("GMT")) assert.ok(error.retryAfterMs! > 0 && error.retryAfterMs! <= 30_000);
      else assert.equal(error.retryAfterMs, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

for (const operation of ["unary", "stream", "rest"] as const) test(`the pre-response timeout also applies to an uncooperative ${operation} fetch`, { timeout: 1000 }, async () => {
  let resolveResponse!: (response: Response) => void;
  let isLateBodyCancelled = false;
  const client = new ConnectClient({ baseURL: local.apiServerURL, timeoutMs: 30,
    fetch: () => new Promise<Response>((resolve) => { resolveResponse = resolve; }),
  });
  const pending = operation === "unary" ? client.unary(STATUS_METHOD, {}) : operation === "stream" ? consume(client) : client.getJSON(local.apiServerURL, "/v3/self");
  await assert.rejects(pending, (error: Error) => error.name === "TimeoutError");
  assert.equal(client.isAuthenticationInvalid, false);
  resolveResponse(new Response(new ReadableStream({ cancel() { isLateBodyCancelled = true; } })));
  await Promise.resolve();
  assert.equal(isLateBodyCancelled, true);
});

test("a response body timeout and an endless cancel still end within the overall deadline", { timeout: 1000 }, async () => {
  for (const isEarlyReturn of [false, true]) {
    let isCancelled = false;
    const client = new ConnectClient({ baseURL: local.apiServerURL, timeoutMs: 30, fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(encodeFrame(chatResponseCodec.encode({ deltaText: "partial" }))); },
      cancel() { isCancelled = true; return new Promise(() => {}); },
    }), { headers: { "content-type": "application/connect+proto" } }) });
    const stream = client.stream(CHAT_METHOD, {});
    await stream.next();
    await assert.rejects(isEarlyReturn ? stream.return(undefined) : stream.next(), (error: Error) => error.name === "TimeoutError");
    assert.equal(isCancelled, true);
  }
});

test("the 415 resend shares the same overall deadline and caller cancel signal", { timeout: 1000 }, async () => {
  const signals: AbortSignal[] = [];
  const caller = new AbortController();
  const client = new ConnectClient({ baseURL: local.apiServerURL, timeoutMs: 60, fetch: async (_url, init) => {
    signals.push(init!.signal!);
    if (signals.length === 1) { await new Promise((resolve) => setTimeout(resolve, 15)); return Response.json({}, { status: 415 }); }
    return new Promise<Response>(() => {});
  } });
  await assert.rejects(async () => { for await (const _ of client.stream(CHAT_METHOD, { prompt: "x".repeat(9000) }, caller.signal)) {} }, (error: Error) => error.name === "TimeoutError");
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(caller.signal.aborted, false);
});

test("caller cancellation is not overwritten by a timeout and the timer of a finished request is released", async () => {
  const caller = new AbortController();
  const cancelled = new ConnectClient({ baseURL: local.apiServerURL, timeoutMs: 5000, fetch: () => new Promise<Response>(() => {}) });
  const pending = cancelled.unary(STATUS_METHOD, {}, caller.signal);
  caller.abort(new DOMException("caller stop", "AbortError"));
  await assert.rejects(pending, (error: Error) => error.name === "AbortError" && error.message === "caller stop");
  let receivedSignal!: AbortSignal;
  const completed = new ConnectClient({ baseURL: local.apiServerURL, timeoutMs: 30, fetch: async (_url, init) => {
    receivedSignal = init!.signal!; return unaryResponse(STATUS_METHOD, statusResponse());
  } });
  await completed.unary(STATUS_METHOD, {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(receivedSignal.aborted, false);
});
