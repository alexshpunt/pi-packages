import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { login } from "../src/core/auth/index.ts";
import { readCredential, saveCredential } from "../src/cli/credentials.ts";
import { RPCError } from "../src/core/protocol/transport.ts";
import { credential as fixtureCredential, requestBody, unaryResponse } from "./helpers.ts";

const EXCHANGE_METHOD = "exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode";
const PKCE_EXCHANGE_METHOD = "exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode";

for (const prefix of ["", "wspkce$"]) test(`standalone PKCE: ${prefix || "plain code"} → exact RPC/fields → private store`, async () => {
  const method = prefix ? PKCE_EXCHANGE_METHOD : EXCHANGE_METHOD;
  const codeField = prefix ? "authorizationCode" : "code";
  const directory = await mkdtemp(join(tmpdir(), "devin-poc-"));
  let challenge = "";
  let exchanges = 0;
  try {
    const credential = await login({
      timeoutMs: 5000,
      onURL: async (value) => {
        const url = new URL(value);
        assert.equal(url.origin, "https://app.devin.ai");
        assert.equal(url.pathname, "/auth/cli/continue");
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        challenge = url.searchParams.get("code_challenge")!;
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ code: "mock-code", state: "wrong" }).toString();
        assert.equal((await fetch(callback)).status, 400);
        assert.equal(exchanges, 0);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        callback.searchParams.set("code", "wspkce$");
        assert.equal((await fetch(callback)).status, 400);
        callback.searchParams.set("code", `${prefix}mock-code`);
        assert.equal((await fetch(callback)).status, 200);
        assert.equal((await fetch(callback)).status, 400);
      },
      fetch: async (url, init) => {
        exchanges++;
        assert.equal(String(url), `https://server.codeium.com/${method}`);
        const body = requestBody(method, init!);
        assert.equal(body[codeField], "mock-code");
        assert.deepEqual(Object.keys(body).sort(), [codeField, "codeVerifier"].sort());
        const headers = new Headers(init!.headers);
        assert.equal(headers.get("content-type"), "application/proto");
        assert.equal(headers.get("connect-protocol-version"), "1");
        assert.equal(headers.get("accept-encoding"), "gzip");
        assert.equal(headers.get("sentry-trace"), null);
        assert.equal(createHash("sha256").update(body.codeVerifier as string).digest("base64url"), challenge);
        assert.equal(new Headers(init!.headers).has("Authorization"), false);
        return unaryResponse(method, { [prefix ? "apiKey" : "sessionToken"]: fixtureCredential.sessionToken, ...(prefix ? { apiServerUrl: "https://server.codeium.com" } : {}) });
      },
    });
    assert.equal(exchanges, 1);
    const file = join(directory, "credentials.json");
    await saveCredential(credential, file);
    assert.deepEqual(await readCredential(file), credential);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OAuth cancel closes the callback server without an exchange request", async () => {
  const controller = new AbortController();
  let callbackURL = "";
  await assert.rejects(login({
    signal: controller.signal,
    onURL: (value) => {
      callbackURL = new URL(value).searchParams.get("redirect_uri")!;
      controller.abort();
    },
    fetch: async () => { assert.fail("the token must not be exchanged after cancel."); },
  }), /cancel|abort/i);
  await assert.rejects(fetch(callbackURL));
});

for (const prefix of ["", "wspkce$"]) test(`OAuth ${prefix || "plain"} exchange errors do not expose the code/verifier`, async () => {
  await assert.rejects(login({
    onURL: async (value) => {
      const url = new URL(value);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: `${prefix}private-code`, state: url.searchParams.get("state")! }).toString();
      await fetch(callback);
    },
    fetch: async (_url, init) => {
      const body = requestBody(prefix ? PKCE_EXCHANGE_METHOD : EXCHANGE_METHOD, init!);
      return Response.json({ code: "invalid_argument", message: (prefix ? body.authorizationCode : body.code) + " " + body.codeVerifier }, { status: 400 });
    },
  }), (error: Error) => error.message === "invalid_argument: [REDACTED] [REDACTED]");
});

test("credentials are not forwarded to a different API server returned by a prefixed login", async () => {
  let calls = 0;
  await assert.rejects(login({
    onURL: async (value) => {
      const url = new URL(value); const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "wspkce$offline-code", state: url.searchParams.get("state")! }).toString();
      await fetch(callback);
    },
    fetch: async (url) => {
      calls++; assert.equal(String(url), `https://server.codeium.com/${PKCE_EXCHANGE_METHOD}`);
      return unaryResponse(PKCE_EXCHANGE_METHOD, { apiKey: fixtureCredential.sessionToken, apiServerUrl: "https://unexpected.invalid" });
    },
  }), /different API server/);
  assert.equal(calls, 1);
});

test("the explicit JSON login compatibility path also exchanges only once", async () => {
  let exchanges = 0;
  const credential = await login({
    encoding: "json", timeoutMs: 5000,
    onURL: async (value) => {
      const url = new URL(value); const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "plain-legacy-code", state: url.searchParams.get("state")! }).toString();
      assert.equal((await fetch(callback)).status, 200);
    },
    fetch: async (_url, init) => {
      exchanges++;
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      assert.equal(JSON.parse(init!.body as string).code, "plain-legacy-code");
      return Response.json({ sessionToken: fixtureCredential.sessionToken });
    },
  });
  assert.equal(exchanges, 1);
  assert.equal(credential.sessionToken, fixtureCredential.sessionToken);
});

for (const encoding of ["proto", "json"] as const) test(`a failed ${encoding} login does not resend the one-time code through another path`, async () => {
  let exchanges = 0;
  await assert.rejects(login({
    encoding, timeoutMs: 5000,
    onURL: async (value) => {
      const url = new URL(value); const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "one-use-code", state: url.searchParams.get("state")! }).toString();
      await fetch(callback);
    },
    fetch: async () => { exchanges++; return Response.json({}, { status: 415 }); },
  }), (error: unknown) => error instanceof RPCError && error.httpStatus === 415);
  assert.equal(exchanges, 1);
});

test("the overall timeout applies even to an unresponsive login UI callback", { timeout: 1000 }, async () => {
  let callbackURL = "";
  await assert.rejects(login({
    timeoutMs: 30,
    onURL: (value) => {
      callbackURL = new URL(value).searchParams.get("redirect_uri")!;
      return new Promise<void>(() => {});
    },
    fetch: async () => { assert.fail("the code must not be exchanged without a callback."); },
  }), (error: Error) => error.name === "TimeoutError");
  await assert.rejects(fetch(callbackURL));
});

test("a login timeout is distinct from cancel and closes the callback without an exchange", async () => {
  let callbackURL = "";
  await assert.rejects(login({
    timeoutMs: 50,
    onURL: (value) => { callbackURL = new URL(value).searchParams.get("redirect_uri")!; },
    fetch: async () => { assert.fail("nothing must be exchanged after the timeout."); },
  }), (error: Error) => error.name === "TimeoutError");
  await assert.rejects(fetch(callbackURL));
});
