import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, InMemoryCredentialStore, type AuthInteraction, type Provider } from "@earendil-works/pi-ai";
import { createDevinAccountAuth, credentialFromOAuth } from "../src/pi/auth.ts";
import { DevinClient } from "../src/core/client.ts";
import { createFingerprintProvider } from "../src/core/protocol/fingerprint.ts";
import { RPCError } from "../src/core/protocol/transport.ts";
import { identity, requestBody, STATUS_METHOD, statusResponse, unaryResponse } from "./helpers.ts";

function host(auth: ReturnType<typeof createDevinAccountAuth>) {
  const storage = new InMemoryCredentialStore();
  const models = createModels({ credentials: storage, authContext: {
    env: async () => { throw new Error("OAuth must not read environment keys"); }, fileExists: async () => false,
  } });
  const phases: boolean[] = [];
  const provider: Provider = {
    id: "devin", name: "Devin", auth: { oauth: auth }, getModels: () => [],
    refreshModels: async (context) => { phases.push(context.allowNetwork); },
    stream: () => { throw new Error("No inference in auth test"); },
    streamSimple: () => { throw new Error("No inference in auth test"); },
  };
  models.setProvider(provider);
  return { models, storage, phases };
}

function manualInteraction(signal?: AbortSignal): AuthInteraction {
  return {
    signal, notify: () => {},
    prompt: async (prompt) => prompt.type === "select" ? "manual" : "wspkce$manual-fake-code",
  };
}

function accountFixture() {
  let status = 200, sends = 0, closed = 0, exchanges = 0;
  const sessionToken = "fake-account-session";
  const auth = createDevinAccountAuth({
    loginOptions: { fetch: async (url, init) => {
      exchanges++;
      const method = new URL(String(url)).pathname.slice(1);
      assert.equal(method.endsWith("/ExchangePKCEAuthorizationCode"), true);
      assert.equal(requestBody(method, init!).authorizationCode, "manual-fake-code");
      return unaryResponse(method, { apiKey: sessionToken });
    } },
    createClient: (credential) => {
      const client = new DevinClient(credential, { profile: "login",
        fingerprint: createFingerprintProvider(credential.sessionToken, { collectIdentity: () => identity }),
        fetch: async (url, init) => {
          sends++;
          assert.equal(new URL(String(url)).pathname, "/" + STATUS_METHOD);
          assert.equal(new Headers(init!.headers).get("authorization"), `Basic ${sessionToken}-${sessionToken}`);
          const body = requestBody(STATUS_METHOD, init!);
          assert.equal((body.metadata as { apiKey: string }).apiKey, sessionToken);
          return status === 200 ? unaryResponse(STATUS_METHOD, statusResponse()) : Response.json({}, { status });
        },
      });
      const close = client.transport.close.bind(client.transport);
      client.transport.close = () => { closed++; close(); };
      return client;
    },
  });
  return { auth, host: host(auth), setStatus: (next: number) => { status = next; }, counts: () => ({ sends, closed, exchanges }) };
}

test("real OAuth adapter → public Models login, repeated resolve, model refresh and logout", async () => {
  const f = accountFixture();
  const loggedIn = await f.host.models.login("devin", "oauth", manualInteraction());
  assert.equal(loggedIn.type, "oauth");
  if (loggedIn.type !== "oauth") assert.fail();
  assert.equal(loggedIn.expires, 0);
  assert.equal(loggedIn.refresh, "");
  assert.equal(f.counts().sends, 0); // Login is not a permission check.
  assert.equal((await f.host.models.checkAuth("devin"))?.type, "oauth");
  const auth = await f.host.models.getAuth("devin");
  assert.equal(auth?.auth.apiKey, loggedIn.access);
  assert.equal(auth?.auth.baseUrl, "https://server.codeium.com");
  const repeated = await Promise.all([f.host.models.getAuth("devin"), f.host.models.getAuth("devin")]);
  assert.equal(repeated.every((value) => value?.auth.apiKey === loggedIn.access), true);
  assert.deepEqual(await f.host.storage.read("devin"), loggedIn); // No new token or fake expires appears.
  await f.host.models.refresh({ allowNetwork: false });
  assert.deepEqual(f.counts(), { sends: 3, closed: 3, exchanges: 1 });
  await f.host.models.refresh({ allowNetwork: true });
  assert.deepEqual(f.host.phases, [false, false, true]);
  assert.deepEqual(f.counts(), { sends: 4, closed: 4, exchanges: 1 });
  await f.host.models.logout("devin");
  assert.equal(await f.host.models.getAuth("devin"), undefined);
  assert.deepEqual(f.counts(), { sends: 4, closed: 4, exchanges: 1 });
});

test("a 401 session is not replayed automatically and an explicit re-login creates a new client", async () => {
  const f = accountFixture();
  const loggedIn = await f.host.models.login("devin", "oauth", manualInteraction());
  f.setStatus(401);
  await assert.rejects(f.host.models.getAuth("devin"), (error: Error & { cause?: unknown }) => error.cause instanceof RPCError && error.cause.kind === "authentication");
  await assert.rejects(f.host.models.getAuth("devin"), /OAuth refresh failed/);
  assert.deepEqual(f.counts(), { sends: 1, closed: 1, exchanges: 1 });
  assert.deepEqual(await f.host.storage.read("devin"), loggedIn);
  const previousGeneration = f.auth.generation;
  f.setStatus(200);
  const renewed = await f.host.models.login("devin", "oauth", manualInteraction());
  assert.equal(renewed.type, "oauth");
  if (renewed.type !== "oauth") assert.fail();
  // A late failure from an older login generation does not invalidate the new login.
  f.auth.invalidate(credentialFromOAuth(renewed), new RPCError("unauthenticated", "old failure"), previousGeneration);
  await f.host.models.getAuth("devin");
  assert.deepEqual(f.counts(), { sends: 2, closed: 2, exchanges: 2 });
});

for (const status of [403, 429]) test(`${status} is not remembered as OAuth token expiry`, async () => {
  const f = accountFixture();
  await f.host.models.login("devin", "oauth", manualInteraction());
  f.setStatus(status);
  await assert.rejects(f.host.models.getAuth("devin"));
  f.setStatus(200);
  await f.host.models.getAuth("devin");
  assert.deepEqual(f.counts(), { sends: 2, closed: 2, exchanges: 1 });
});

test("Pi browser login and the callback/manual prompt race use the same shared REST exchange", async () => {
  let callback!: URL, promptSignal!: AbortSignal, request: Promise<Response> | undefined, exchanges = 0;
  const auth = createDevinAccountAuth({ loginOptions: { fetch: async (url, init) => {
    exchanges++;
    assert.equal(String(url), "https://api.devin.ai/auth/cli/token");
    assert.equal(JSON.parse(init!.body as string).code, "pi-browser-code");
    return Response.json({ token: "pi.fake.session" });
  } } });
  const f = host(auth);
  const credential = await f.models.login("devin", "oauth", {
    notify(event) {
      if (event.type !== "auth_url") return;
      const url = new URL(event.url);
      callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({ code: "pi-browser-code", state: url.searchParams.get("state")! }).toString();
    },
    prompt: async (prompt) => {
      if (prompt.type === "select") return "browser";
      assert.equal(prompt.type, "manual_code");
      promptSignal = prompt.signal!;
      request = fetch(callback);
      return new Promise<string>(() => {});
    },
  });
  assert.equal((await request!).status, 200);
  assert.equal(promptSignal.aborted, true);
  assert.equal(exchanges, 1);
  assert.equal(credential.type, "oauth");
  assert.deepEqual(await f.storage.read("devin"), credential);
});

test("the host 15000ms refresh signal ends the final status request and a local timeout is not remembered as auth expiry", async (context) => {
  let deadline!: AbortController, calls = 0, closed = 0, finalSignal!: AbortSignal;
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 15_000); deadline = new AbortController(); return deadline.signal;
  });
  const auth = createDevinAccountAuth({ createClient: (credential) => {
    const client = new DevinClient(credential, {
      fingerprint: createFingerprintProvider(credential.sessionToken, { collectIdentity: () => identity }),
      fetch: async (_url, init) => {
        calls++; finalSignal = init!.signal!;
        if (calls === 1) { deadline.abort(new DOMException("host timeout", "TimeoutError")); return new Promise(() => {}); }
        return unaryResponse(STATUS_METHOD, statusResponse());
      },
    });
    const close = client.transport.close.bind(client.transport);
    client.transport.close = () => { closed++; close(); };
    return client;
  } });
  const f = host(auth);
  const stored = { type: "oauth" as const, access: "fake-timeout-token", refresh: "", expires: 0,
    devin: { version: 1, apiServerURL: "https://example.invalid", createdAt: "2026-01-01T00:00:00.000Z" } };
  await f.storage.modify("devin", async () => stored);
  await assert.rejects(f.models.getAuth("devin"), (error: Error & { cause?: Error }) => error.cause?.name === "TimeoutError");
  assert.equal(finalSignal.aborted, true);
  assert.equal(closed, 1);
  assert.deepEqual(await f.storage.read("devin"), stored);
  await f.models.getAuth("devin");
  assert.equal(calls, 2); assert.equal(closed, 2);
});

test("cancelling Pi login stops the prompt and neither saves nor exchanges", async () => {
  const controller = new AbortController(); let inputSignal!: AbortSignal, exchanges = 0;
  const auth = createDevinAccountAuth({ loginOptions: { fetch: async () => { exchanges++; assert.fail(); } } });
  const f = host(auth);
  await assert.rejects(f.models.login("devin", "oauth", {
    signal: controller.signal, notify: () => {},
    prompt: async (prompt) => {
      if (prompt.type === "select") return "manual";
      inputSignal = prompt.signal!;
      controller.abort();
      return new Promise(() => {});
    },
  }), { name: "AbortError" });
  assert.equal(inputSignal.aborted, true);
  assert.equal(exchanges, 0);
  assert.equal(await f.storage.read("devin"), undefined);
});
