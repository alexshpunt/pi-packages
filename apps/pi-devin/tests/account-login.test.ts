import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loginAccount } from "../src/core/auth/index.ts";
import { RPCError } from "../src/core/protocol/transport.ts";
import { credential, requestBody, unaryResponse } from "./helpers.ts";

function callbackFor(url: URL, code = "browser-code"): URL {
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({ code, state: url.searchParams.get("state")! }).toString();
  return callback;
}

test("the default account login exchanges browser PKCE once over REST JSON", async () => {
  let challenge = "", calls = 0, callbackURL = "";
  const result = await loginAccount({
    onURL: async (value) => {
      const url = new URL(value);
      assert.equal(url.href.startsWith("https://app.devin.ai/auth/cli/continue?"), true);
      assert.equal(url.searchParams.get("prompt"), "select_account");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.match(url.searchParams.get("state")!, /^[0-9a-f-]{36}$/);
      challenge = url.searchParams.get("code_challenge")!;
      const callback = callbackFor(url); callbackURL = callback.origin;
      assert.equal((await fetch(callback, { method: "POST" })).status, 404);
      const wrong = new URL(callback); wrong.searchParams.set("state", "wrong");
      assert.equal((await fetch(wrong)).status, 400);
      assert.equal((await fetch(callback)).status, 200);
      assert.equal((await fetch(callback)).status, 400);
    },
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), "https://api.devin.ai/auth/cli/token");
      assert.equal(init!.redirect, "error");
      assert.equal(init!.method, "POST");
      const headers = new Headers(init!.headers);
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(headers.get("accept"), "application/json");
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.has("connect-protocol-version"), false);
      const body = JSON.parse(init!.body as string);
      assert.deepEqual(Object.keys(body).sort(), ["code", "code_verifier"]);
      assert.equal(body.code, "browser-code");
      assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), challenge);
      return Response.json({ token: "fake.jwt.signature" });
    },
  });
  assert.equal(result.sessionToken, "devin-session-token$fake.jwt.signature");
  assert.equal(result.version, 1);
  assert.equal(calls, 1);
  await assert.rejects(fetch(callbackURL));
});

for (const prefix of ["", "wspkce$"]) test(`native manual code ${prefix || "plain"}: URL, PKCE and Connect consumption`, async () => {
  const method = prefix ? "exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode" : "exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode";
  let challenge = "", calls = 0;
  const result = await loginAccount({
    flow: "manual",
    onURL: (value) => {
      const url = new URL(value);
      assert.equal(url.pathname, "/devin/account/login");
      assert.equal(url.searchParams.get("redirect_uri"), "chisel-show-auth-token");
      assert.equal(url.searchParams.has("prompt"), false);
      assert.match(url.searchParams.get("state")!, /^[0-9a-f-]{36}$/);
      challenge = url.searchParams.get("code_challenge")!;
    },
    promptCode: async () => prefix + "manual-code",
    fetch: async (url, init) => {
      calls++; assert.equal(String(url), "https://server.codeium.com/" + method);
      const body = requestBody(method, init!);
      assert.equal(body[prefix ? "authorizationCode" : "code"], "manual-code");
      assert.equal(createHash("sha256").update(body.codeVerifier as string).digest("base64url"), challenge);
      assert.equal(new Headers(init!.headers).get("content-type"), "application/proto");
      return unaryResponse(method, { [prefix ? "apiKey" : "sessionToken"]: credential.sessionToken });
    },
  });
  assert.equal(result.sessionToken, credential.sessionToken);
  assert.equal(calls, 1);
});

test("when the browser callback wins, the uncooperative manual input is cancelled and the code is exchanged once", { timeout: 2000 }, async () => {
  let callback!: URL, inputSignal!: AbortSignal, calls = 0;
  let callbackRequest: Promise<Response> | undefined;
  const result = await loginAccount({
    onURL: (value) => { callback = callbackFor(new URL(value)); },
    promptCode: (signal) => {
      inputSignal = signal;
      callbackRequest = fetch(callback);
      return new Promise<string>(() => {});
    },
    fetch: async () => { calls++; return Response.json({ token: "fake.session" }); },
  });
  assert.equal(result.sessionToken, "devin-session-token$fake.session");
  assert.equal((await callbackRequest!).status, 200);
  assert.equal(inputSignal.aborted, true);
  assert.equal(calls, 1);
});

test("a manual browser paste checks the callback URL and state", async () => {
  let value = "", calls = 0;
  await assert.rejects(loginAccount({
    onURL: (url) => { value = callbackFor(new URL(url)).href.replace("state=", "state=wrong"); },
    promptCode: async () => value,
    fetch: async () => { calls++; assert.fail("wrong state"); },
  }), /state/);
  assert.equal(calls, 0);
});

for (const [label, code] of [["empty", ""], ["prefix only", "wspkce$"], ["session token", "devin-session-token$not-an-auth-code"], ["API key", "cog_not-an-auth-code"]]) test(`rejects the wrong kind of manual code before sending: ${label}`, async () => {
  let calls = 0;
  await assert.rejects(loginAccount({ flow: "manual", onURL: () => {}, promptCode: async () => code,
    fetch: async () => { calls++; assert.fail("invalid code"); },
  }), /authorization code/);
  assert.equal(calls, 0);
});

test("flow/encoding conflicts are rejected before opening any UI", async () => {
  let opens = 0;
  const onURL = () => { opens++; };
  await assert.rejects(loginAccount({ flow: "browser", encoding: "proto", onURL }), /encoding/);
  await assert.rejects(loginAccount({ flow: "manual", devinAPIURL: "https://example.invalid", promptCode: async () => "code", onURL }), /REST login server/);
  assert.equal(opens, 0);
});

test("an explicit JSON option uses the legacy Connect path in account login too", async () => {
  let calls = 0;
  await loginAccount({ encoding: "json",
    onURL: async (url) => { await fetch(callbackFor(new URL(url))); },
    fetch: async (url, init) => {
      calls++; assert.equal(new URL(String(url)).pathname.endsWith("/ExchangeDevinCLIPKCECode"), true);
      assert.equal(JSON.parse(init!.body as string).code, "browser-code");
      assert.equal(new Headers(init!.headers).get("connect-protocol-version"), "1");
      return Response.json({ sessionToken: credential.sessionToken });
    },
  });
  assert.equal(calls, 1);
});

test("REST 415 is not resent over Connect or another encoding", async () => {
  let calls = 0;
  await assert.rejects(loginAccount({
    onURL: async (url) => { await fetch(callbackFor(new URL(url))); },
    fetch: async () => { calls++; return Response.json({ detail: "private-code" }, { status: 415 }); },
  }), (error: unknown) => error instanceof RPCError && error.httpStatus === 415 && !error.message.includes("private-code"));
  assert.equal(calls, 1);
});

test("the 300000ms login and 30000ms exchange limits reach the final input and body consumption signals", async (context) => {
  const timers = new Map<number, AbortController>();
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    const controller = new AbortController(); timers.set(milliseconds, controller); return controller.signal;
  });
  const timeout = () => new DOMException("timeout", "TimeoutError");
  let inputSignal!: AbortSignal;
  await assert.rejects(loginAccount({ flow: "manual", onURL: () => {}, promptCode: (signal) => {
    inputSignal = signal; timers.get(300_000)!.abort(timeout()); return new Promise(() => {});
  } }), { name: "TimeoutError" });
  assert.equal(inputSignal.aborted, true);
  let bodyCancelled = false, finalSignal!: AbortSignal;
  await assert.rejects(loginAccount({ onURL: () => {}, promptCode: async () => "body-timeout-code",
    fetch: async (_url, init) => {
      finalSignal = init!.signal!;
      assert.equal(finalSignal.aborted, false);
      return new Response(new ReadableStream({
        pull() { timers.get(30_000)!.abort(timeout()); },
        cancel() { bodyCancelled = true; },
      }, { highWaterMark: 0 }));
    },
  }), { name: "TimeoutError" });
  assert.equal(finalSignal.aborted, true);
  assert.equal(bodyCancelled, true);
});

test("the REST flow does not switch to Connect based on the code prefix alone", async () => {
  let calls = 0;
  await loginAccount({ onURL: () => {}, promptCode: async () => "wspkce$browser-contract-code",
    fetch: async (url, init) => {
      calls++; assert.equal(new URL(String(url)).pathname, "/auth/cli/token");
      assert.equal(JSON.parse(init!.body as string).code, "wspkce$browser-contract-code");
      return Response.json({ token: "fake.session" });
    },
  });
  assert.equal(calls, 1);
});

for (const [label, body] of [["size", "x".repeat(65_537)], ["JSON", '{"token":"unprefixed-private-value']]) test(`REST response ${label} limit without exposing the raw text`, async () => {
  await assert.rejects(loginAccount({ onURL: () => {}, promptCode: async () => "bounded-code",
    fetch: async () => new Response(body),
  }), (error: Error) => !error.message.includes("unprefixed-private-value") && error.message.length < 800);
});

// Holds an input handle like a real prompt and releases it on cancel. A wait without a handle is cancelled by the Node 22 test runner as an empty loop.
const pendingInput = (signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
  const hold = setInterval(() => {}, 1_000);
  signal.addEventListener("abort", () => { clearInterval(hold); reject(signal.reason); }, { once: true });
});

test("cancellation and the overall limit reach the manual input and the REST exchange", async () => {
  await assert.rejects(loginAccount({ flow: "manual", timeoutMs: 20, onURL: () => {}, promptCode: pendingInput }), { name: "TimeoutError" });
  const controller = new AbortController(); let finalSignal!: AbortSignal;
  await assert.rejects(loginAccount({ signal: controller.signal,
    onURL: async (url) => { await fetch(callbackFor(new URL(url))); },
    fetch: async (_url, init) => { finalSignal = init!.signal!; controller.abort(); return new Promise(() => {}); },
  }), { name: "AbortError" });
  assert.equal(finalSignal.aborted, true);
});
