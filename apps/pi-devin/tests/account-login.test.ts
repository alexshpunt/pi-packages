import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { RPCError } from "../src/core/errors.ts";
import { accountLogin, credential, fromAsync, requestBody, run, settle, unaryResponse } from "./helpers.ts";

function callbackFor(url: URL, code = "browser-code"): URL {
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({ code, state: url.searchParams.get("state")! }).toString();
  return callback;
}

test("the default account login exchanges browser PKCE once over REST JSON", async () => {
  let challenge = "", calls = 0, callbackURL = "";
  const result = await run(accountLogin({
    onURL: (value) => fromAsync(async () => {
      const url = new URL(value);
      expect(url.href.startsWith("https://app.devin.ai/auth/cli/continue?")).toBe(true);
      expect(url.searchParams.get("prompt")).toBe("select_account");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("state")!).toMatch(/^[0-9a-f-]{36}$/);
      challenge = url.searchParams.get("code_challenge")!;
      const callback = callbackFor(url); callbackURL = callback.origin;
      expect((await fetch(callback, { method: "POST" })).status).toBe(404);
      const wrong = new URL(callback); wrong.searchParams.set("state", "wrong");
      expect((await fetch(wrong)).status).toBe(400);
      expect((await fetch(callback)).status).toBe(200);
      expect((await fetch(callback)).status).toBe(400);
    }),
    fetch: async (url, init) => {
      calls++;
      expect(String(url)).toBe("https://api.devin.ai/auth/cli/token");
      expect(init!.redirect).toBe("error");
      expect(init!.method).toBe("POST");
      const headers = new Headers(init!.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("connect-protocol-version")).toBe(false);
      const body = JSON.parse(init!.body as string);
      expect(Object.keys(body).sort()).toStrictEqual(["code", "code_verifier"]);
      expect(body.code).toBe("browser-code");
      expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(challenge);
      return Response.json({ token: "fake.jwt.signature" });
    },
  }));
  expect(result.sessionToken).toBe("devin-session-token$fake.jwt.signature");
  expect(result.version).toBe(1);
  expect(calls).toBe(1);
  await expect(fetch(callbackURL)).rejects.toThrow();
});

for (const prefix of ["", "wspkce$"]) test(`native manual code ${prefix || "plain"}: URL, PKCE and Connect consumption`, async () => {
  const method = prefix ? "exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode" : "exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode";
  let challenge = "", calls = 0;
  const result = await run(accountLogin({
    flow: "manual",
    onURL: (value) => fromAsync(() => {
      const url = new URL(value);
      expect(url.pathname).toBe("/devin/account/login");
      expect(url.searchParams.get("redirect_uri")).toBe("chisel-show-auth-token");
      expect(url.searchParams.has("prompt")).toBe(false);
      expect(url.searchParams.get("state")!).toMatch(/^[0-9a-f-]{36}$/);
      challenge = url.searchParams.get("code_challenge")!;
    }),
    promptCode: fromAsync(() => prefix + "manual-code"),
    fetch: async (url, init) => {
      calls++; expect(String(url)).toBe("https://server.codeium.com/" + method);
      const body = requestBody(method, init!);
      expect(body[prefix ? "authorizationCode" : "code"]).toBe("manual-code");
      expect(createHash("sha256").update(body.codeVerifier as string).digest("base64url")).toBe(challenge);
      expect(new Headers(init!.headers).get("content-type")).toBe("application/proto");
      return unaryResponse(method, { [prefix ? "apiKey" : "sessionToken"]: credential.sessionToken });
    },
  }));
  expect(result.sessionToken).toBe(credential.sessionToken);
  expect(calls).toBe(1);
});

test("when the browser callback wins, the uncooperative manual input is cancelled and the code is exchanged once", { timeout: 2000 }, async () => {
  let callback!: URL, inputSignal!: AbortSignal, calls = 0;
  let callbackRequest: Promise<Response> | undefined;
  const result = await run(accountLogin({
    onURL: (value) => fromAsync(() => { callback = callbackFor(new URL(value)); }),
    promptCode: fromAsync((signal) => {
      inputSignal = signal;
      callbackRequest = fetch(callback);
      return new Promise<string>(() => {});
    }),
    fetch: async () => { calls++; return Response.json({ token: "fake.session" }); },
  }));
  expect(result.sessionToken).toBe("devin-session-token$fake.session");
  expect((await callbackRequest!).status).toBe(200);
  expect(inputSignal.aborted).toBe(true);
  expect(calls).toBe(1);
});

test("a manual browser paste checks the callback URL and state", async () => {
  let value = "", calls = 0;
  await expect(run(accountLogin({
    onURL: (url) => fromAsync(() => { value = callbackFor(new URL(url)).href.replace("state=", "state=wrong"); }),
    promptCode: fromAsync(() => value),
    fetch: async () => { calls++; expect.unreachable("wrong state"); },
  }))).rejects.toThrow(/state/);
  expect(calls).toBe(0);
});

for (const [label, code] of [["empty", ""], ["prefix only", "wspkce$"], ["session token", "devin-session-token$not-an-auth-code"], ["API key", "cog_not-an-auth-code"]]) test(`rejects the wrong kind of manual code before sending: ${label}`, async () => {
  let calls = 0;
  await expect(run(accountLogin({ flow: "manual", onURL: () => fromAsync(() => {}), promptCode: fromAsync(() => code),
    fetch: async () => { calls++; expect.unreachable("invalid code"); },
  }))).rejects.toThrow(/authorization code/);
  expect(calls).toBe(0);
});

test("flow/encoding conflicts are rejected before opening any UI", async () => {
  let opens = 0;
  const onURL = () => fromAsync(() => { opens++; });
  await expect(run(accountLogin({ flow: "browser", encoding: "proto", onURL }))).rejects.toThrow(/encoding/);
  await expect(run(accountLogin({ flow: "manual", devinAPIURL: "https://example.invalid", promptCode: fromAsync(() => "code"), onURL }))).rejects.toThrow(/REST login server/);
  expect(opens).toBe(0);
});

test("an explicit JSON option uses the legacy Connect path in account login too", async () => {
  let calls = 0;
  await run(accountLogin({ encoding: "json",
    onURL: (url) => fromAsync(async () => { await fetch(callbackFor(new URL(url))); }),
    fetch: async (url, init) => {
      calls++; expect(new URL(String(url)).pathname.endsWith("/ExchangeDevinCLIPKCECode")).toBe(true);
      expect(JSON.parse(init!.body as string).code).toBe("browser-code");
      expect(new Headers(init!.headers).get("connect-protocol-version")).toBe("1");
      return Response.json({ sessionToken: credential.sessionToken });
    },
  }));
  expect(calls).toBe(1);
});

test("REST 415 is not resent over Connect or another encoding", async () => {
  let calls = 0;
  await expect(run(accountLogin({
    onURL: (url) => fromAsync(async () => { await fetch(callbackFor(new URL(url))); }),
    fetch: async () => { calls++; return Response.json({ detail: "private-code" }, { status: 415 }); },
  }))).rejects.toThrow(expect.toSatisfy((error: unknown) => error instanceof RPCError && error.httpStatus === 415 && !error.message.includes("private-code")));
  expect(calls).toBe(1);
});

test("the 300000ms login and 30000ms exchange limits reach the final input and body consumption signals", async (context) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); context.onTestFinished(() => { vi.useRealTimers(); });
  let inputSignal!: AbortSignal, reachedInput!: () => void;
  const inputReached = new Promise<void>((resolve) => { reachedInput = resolve; });
  const manual = run(accountLogin({ flow: "manual", onURL: () => fromAsync(() => {}), promptCode: fromAsync((signal) => {
    inputSignal = signal; reachedInput(); return new Promise<string>(() => {});
  }) }));
  const manualRejection = expect(manual).rejects.toThrow(expect.objectContaining({ name: "TimeoutError" }));
  await inputReached;
  vi.advanceTimersByTime(299_999); await settle();
  expect(inputSignal.aborted).toBe(false);
  vi.advanceTimersByTime(1);
  await manualRejection;
  expect(inputSignal.aborted).toBe(true);
  let bodyCancelled = false, finalSignal!: AbortSignal, reachedBody!: () => void;
  const bodyReached = new Promise<void>((resolve) => { reachedBody = resolve; });
  const exchange = run(accountLogin({ onURL: () => fromAsync(() => {}), promptCode: fromAsync(() => "body-timeout-code"),
    fetch: async (_url, init) => {
      finalSignal = init!.signal!;
      expect(finalSignal.aborted).toBe(false);
      return new Response(new ReadableStream({
        pull() { reachedBody(); },
        cancel() { bodyCancelled = true; },
      }, { highWaterMark: 0 }));
    },
  }));
  const exchangeRejection = expect(exchange).rejects.toThrow(expect.objectContaining({ name: "TimeoutError" }));
  await bodyReached;
  vi.advanceTimersByTime(29_999); await settle();
  expect(finalSignal.aborted).toBe(false);
  vi.advanceTimersByTime(1);
  await exchangeRejection;
  expect(finalSignal.aborted).toBe(true);
  expect(bodyCancelled).toBe(true);
});

test("the REST flow does not switch to Connect based on the code prefix alone", async () => {
  let calls = 0;
  await run(accountLogin({ onURL: () => fromAsync(() => {}), promptCode: fromAsync(() => "wspkce$browser-contract-code"),
    fetch: async (url, init) => {
      calls++; expect(new URL(String(url)).pathname).toBe("/auth/cli/token");
      expect(JSON.parse(init!.body as string).code).toBe("wspkce$browser-contract-code");
      return Response.json({ token: "fake.session" });
    },
  }));
  expect(calls).toBe(1);
});

for (const [label, body] of [["size", "x".repeat(65_537)], ["JSON", '{"token":"unprefixed-private-value']]) test(`REST response ${label} limit without exposing the raw text`, async () => {
  await expect(run(accountLogin({ onURL: () => fromAsync(() => {}), promptCode: fromAsync(() => "bounded-code"),
    fetch: async () => new Response(body),
  }))).rejects.toThrow(expect.toSatisfy((error: Error) => !error.message.includes("unprefixed-private-value") && error.message.length < 800));
});

// Holds an input handle like a real prompt and releases it on cancel. A wait without a handle is cancelled by the Node 22 test runner as an empty loop.
const pendingInput = (signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
  const hold = setInterval(() => {}, 1_000);
  signal.addEventListener("abort", () => { clearInterval(hold); reject(signal.reason); }, { once: true });
});

test("cancellation and the overall limit reach the manual input and the REST exchange", async () => {
  await expect(run(accountLogin({ flow: "manual", timeoutMs: 20, onURL: () => fromAsync(() => {}), promptCode: fromAsync(pendingInput) }))).rejects.toThrow(expect.objectContaining({ name: "TimeoutError" }));
  const controller = new AbortController(); let finalSignal!: AbortSignal;
  await expect(run(accountLogin({
    onURL: (url) => fromAsync(async () => { await fetch(callbackFor(new URL(url))); }),
    fetch: async (_url, init) => { finalSignal = init!.signal!; controller.abort(); return new Promise(() => {}); },
  }), controller.signal)).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  expect(finalSignal.aborted).toBe(true);
});
