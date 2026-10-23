import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { RPCError } from "../src/core/errors.ts";
import { stateFiles } from "./cli-helpers.ts";
import { credential as fixtureCredential, fromAsync, legacyLogin, requestBody, run, unaryResponse } from "./helpers.ts";

const EXCHANGE_METHOD = "exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode";
const PKCE_EXCHANGE_METHOD = "exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode";

for (const prefix of ["", "wspkce$"]) test(`standalone PKCE: ${prefix || "plain code"} → exact RPC/fields → private store`, async () => {
  const method = prefix ? PKCE_EXCHANGE_METHOD : EXCHANGE_METHOD;
  const codeField = prefix ? "authorizationCode" : "code";
  const directory = await mkdtemp(join(tmpdir(), "devin-poc-"));
  let challenge = "";
  let exchanges = 0;
  try {
    const credential = await run(legacyLogin({
      timeoutMs: 5000,
      onURL: (value) => fromAsync(async () => {
        const url = new URL(value);
        expect(url.origin).toBe("https://app.devin.ai");
        expect(url.pathname).toBe("/auth/cli/continue");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        challenge = url.searchParams.get("code_challenge")!;
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ code: "mock-code", state: "wrong" }).toString();
        expect((await fetch(callback)).status).toBe(400);
        expect(exchanges).toBe(0);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        callback.searchParams.set("code", "wspkce$");
        expect((await fetch(callback)).status).toBe(400);
        callback.searchParams.set("code", `${prefix}mock-code`);
        expect((await fetch(callback)).status).toBe(200);
        expect((await fetch(callback)).status).toBe(400);
      }),
      fetch: async (url, init) => {
        exchanges++;
        expect(String(url)).toBe(`https://server.codeium.com/${method}`);
        const body = requestBody(method, init!);
        expect(body[codeField]).toBe("mock-code");
        expect(Object.keys(body).sort()).toStrictEqual([codeField, "codeVerifier"].sort());
        const headers = new Headers(init!.headers);
        expect(headers.get("content-type")).toBe("application/proto");
        expect(headers.get("connect-protocol-version")).toBe("1");
        expect(headers.get("accept-encoding")).toBe("gzip");
        expect(headers.get("sentry-trace")).toBe(null);
        expect(createHash("sha256").update(body.codeVerifier as string).digest("base64url")).toBe(challenge);
        expect(new Headers(init!.headers).has("Authorization")).toBe(false);
        return unaryResponse(method, { [prefix ? "apiKey" : "sessionToken"]: fixtureCredential.sessionToken, ...(prefix ? { apiServerUrl: "https://server.codeium.com" } : {}) });
      },
    }));
    expect(exchanges).toBe(1);
    const file = join(directory, "credentials.json");
    await run(stateFiles(file).saveCredential(credential));
    expect(await run(stateFiles(file).readCredential)).toStrictEqual(credential);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OAuth cancel closes the callback server without an exchange request", async () => {
  const controller = new AbortController();
  let callbackURL = "";
  await expect(run(legacyLogin({
    onURL: (value) => fromAsync(() => {
      callbackURL = new URL(value).searchParams.get("redirect_uri")!;
      controller.abort();
    }),
    fetch: async () => { expect.unreachable("the token must not be exchanged after cancel."); },
  }), controller.signal)).rejects.toThrow(/cancel|abort/i);
  await expect(fetch(callbackURL)).rejects.toThrow();
});

for (const prefix of ["", "wspkce$"]) test(`OAuth ${prefix || "plain"} exchange errors do not expose the code/verifier`, async () => {
  await expect(run(legacyLogin({
    onURL: (value) => fromAsync(async () => {
      const url = new URL(value);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: `${prefix}private-code`, state: url.searchParams.get("state")! }).toString();
      await fetch(callback);
    }),
    fetch: async (_url, init) => {
      const body = requestBody(prefix ? PKCE_EXCHANGE_METHOD : EXCHANGE_METHOD, init!);
      return Response.json({ code: "invalid_argument", message: (prefix ? body.authorizationCode : body.code) + " " + body.codeVerifier }, { status: 400 });
    },
  }))).rejects.toThrow(expect.toSatisfy((error: Error) => error.message === "invalid_argument: [REDACTED] [REDACTED]"));
});

test("credentials are not forwarded to a different API server returned by a prefixed login", async () => {
  let calls = 0;
  await expect(run(legacyLogin({
    onURL: (value) => fromAsync(async () => {
      const url = new URL(value); const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "wspkce$offline-code", state: url.searchParams.get("state")! }).toString();
      await fetch(callback);
    }),
    fetch: async (url) => {
      calls++; expect(String(url)).toBe(`https://server.codeium.com/${PKCE_EXCHANGE_METHOD}`);
      return unaryResponse(PKCE_EXCHANGE_METHOD, { apiKey: fixtureCredential.sessionToken, apiServerUrl: "https://unexpected.invalid" });
    },
  }))).rejects.toThrow(/different API server/);
  expect(calls).toBe(1);
});

test("the explicit JSON login compatibility path also exchanges only once", async () => {
  let exchanges = 0;
  const credential = await run(legacyLogin({
    encoding: "json", timeoutMs: 5000,
    onURL: (value) => fromAsync(async () => {
      const url = new URL(value); const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "plain-legacy-code", state: url.searchParams.get("state")! }).toString();
      expect((await fetch(callback)).status).toBe(200);
    }),
    fetch: async (_url, init) => {
      exchanges++;
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(new Headers(init?.headers).get("authorization")).toBe(null);
      expect(JSON.parse(init!.body as string).code).toBe("plain-legacy-code");
      return Response.json({ sessionToken: fixtureCredential.sessionToken });
    },
  }));
  expect(exchanges).toBe(1);
  expect(credential.sessionToken).toBe(fixtureCredential.sessionToken);
});

for (const encoding of ["proto", "json"] as const) test(`a failed ${encoding} login does not resend the one-time code through another path`, async () => {
  let exchanges = 0;
  await expect(run(legacyLogin({
    encoding, timeoutMs: 5000,
    onURL: (value) => fromAsync(async () => {
      const url = new URL(value); const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "one-use-code", state: url.searchParams.get("state")! }).toString();
      await fetch(callback);
    }),
    fetch: async () => { exchanges++; return Response.json({}, { status: 415 }); },
  }))).rejects.toThrow(expect.toSatisfy((error: unknown) => error instanceof RPCError && error.httpStatus === 415));
  expect(exchanges).toBe(1);
});

test("the overall timeout applies even to an unresponsive login UI callback", { timeout: 1000 }, async () => {
  let callbackURL = "";
  await expect(run(legacyLogin({
    timeoutMs: 30,
    onURL: (value) => fromAsync(() => {
      callbackURL = new URL(value).searchParams.get("redirect_uri")!;
      return new Promise<void>(() => {});
    }),
    fetch: async () => { expect.unreachable("the code must not be exchanged without a callback."); },
  }))).rejects.toThrow(expect.toSatisfy((error: Error) => error.name === "TimeoutError"));
  await expect(fetch(callbackURL)).rejects.toThrow();
});

test("a login timeout is distinct from cancel and closes the callback without an exchange", async () => {
  let callbackURL = "";
  await expect(run(legacyLogin({
    timeoutMs: 50,
    onURL: (value) => fromAsync(() => { callbackURL = new URL(value).searchParams.get("redirect_uri")!; }),
    fetch: async () => { expect.unreachable("nothing must be exchanged after the timeout."); },
  }))).rejects.toThrow(expect.toSatisfy((error: Error) => error.name === "TimeoutError"));
  await expect(fetch(callbackURL)).rejects.toThrow();
});
