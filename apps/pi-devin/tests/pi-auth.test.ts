import { expect, test, vi } from "vitest";
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
      expect(method.endsWith("/ExchangePKCEAuthorizationCode")).toBe(true);
      expect(requestBody(method, init!).authorizationCode).toBe("manual-fake-code");
      return unaryResponse(method, { apiKey: sessionToken });
    } },
    createClient: (credential) => {
      const client = new DevinClient(credential, { profile: "login",
        fingerprint: createFingerprintProvider(credential.sessionToken, { collectIdentity: () => identity }),
        fetch: async (url, init) => {
          sends++;
          expect(new URL(String(url)).pathname).toBe("/" + STATUS_METHOD);
          expect(new Headers(init!.headers).get("authorization")).toBe(`Basic ${sessionToken}-${sessionToken}`);
          const body = requestBody(STATUS_METHOD, init!);
          expect((body.metadata as { apiKey: string }).apiKey).toBe(sessionToken);
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
  expect(loggedIn.type).toBe("oauth");
  if (loggedIn.type !== "oauth") expect.unreachable();
  expect(loggedIn.expires).toBe(0);
  expect(loggedIn.refresh).toBe("");
  expect(f.counts().sends).toBe(0); // Login is not a permission check.
  expect((await f.host.models.checkAuth("devin"))?.type).toBe("oauth");
  const auth = await f.host.models.getAuth("devin");
  expect(auth?.auth.apiKey).toBe(loggedIn.access);
  expect(auth?.auth.baseUrl).toBe("https://server.codeium.com");
  const repeated = await Promise.all([f.host.models.getAuth("devin"), f.host.models.getAuth("devin")]);
  expect(repeated.every((value) => value?.auth.apiKey === loggedIn.access)).toBe(true);
  expect(await f.host.storage.read("devin")).toStrictEqual(loggedIn); // No new token or fake expires appears.
  await f.host.models.refresh({ allowNetwork: false });
  expect(f.counts()).toStrictEqual({ sends: 3, closed: 3, exchanges: 1 });
  await f.host.models.refresh({ allowNetwork: true });
  expect(f.host.phases).toStrictEqual([false, false, true]);
  expect(f.counts()).toStrictEqual({ sends: 4, closed: 4, exchanges: 1 });
  await f.host.models.logout("devin");
  expect(await f.host.models.getAuth("devin")).toBe(undefined);
  expect(f.counts()).toStrictEqual({ sends: 4, closed: 4, exchanges: 1 });
});

test("a 401 session is not replayed automatically and an explicit re-login creates a new client", async () => {
  const f = accountFixture();
  const loggedIn = await f.host.models.login("devin", "oauth", manualInteraction());
  f.setStatus(401);
  await expect(f.host.models.getAuth("devin")).rejects.toThrow(expect.toSatisfy((error: Error & { cause?: unknown }) => error.cause instanceof RPCError && error.cause.kind === "authentication"));
  await expect(f.host.models.getAuth("devin")).rejects.toThrow(/OAuth refresh failed/);
  expect(f.counts()).toStrictEqual({ sends: 1, closed: 1, exchanges: 1 });
  expect(await f.host.storage.read("devin")).toStrictEqual(loggedIn);
  const previousGeneration = f.auth.generation;
  f.setStatus(200);
  const renewed = await f.host.models.login("devin", "oauth", manualInteraction());
  expect(renewed.type).toBe("oauth");
  if (renewed.type !== "oauth") expect.unreachable();
  // A late failure from an older login generation does not invalidate the new login.
  f.auth.invalidate(credentialFromOAuth(renewed), new RPCError("unauthenticated", "old failure"), previousGeneration);
  await f.host.models.getAuth("devin");
  expect(f.counts()).toStrictEqual({ sends: 2, closed: 2, exchanges: 2 });
});

for (const status of [403, 429]) test(`${status} is not remembered as OAuth token expiry`, async () => {
  const f = accountFixture();
  await f.host.models.login("devin", "oauth", manualInteraction());
  f.setStatus(status);
  await expect(f.host.models.getAuth("devin")).rejects.toThrow();
  f.setStatus(200);
  await f.host.models.getAuth("devin");
  expect(f.counts()).toStrictEqual({ sends: 2, closed: 2, exchanges: 1 });
});

test("Pi browser login and the callback/manual prompt race use the same shared REST exchange", async () => {
  let callback!: URL, promptSignal!: AbortSignal, request: Promise<Response> | undefined, exchanges = 0;
  const auth = createDevinAccountAuth({ loginOptions: { fetch: async (url, init) => {
    exchanges++;
    expect(String(url)).toBe("https://api.devin.ai/auth/cli/token");
    expect(JSON.parse(init!.body as string).code).toBe("pi-browser-code");
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
      expect(prompt.type).toBe("manual_code");
      promptSignal = prompt.signal!;
      request = fetch(callback);
      return new Promise<string>(() => {});
    },
  });
  expect((await request!).status).toBe(200);
  expect(promptSignal.aborted).toBe(true);
  expect(exchanges).toBe(1);
  expect(credential.type).toBe("oauth");
  expect(await f.storage.read("devin")).toStrictEqual(credential);
});

test("the host 15000ms refresh signal ends the final status request and a local timeout is not remembered as auth expiry", async (context) => {
  let deadline!: AbortController, calls = 0, closed = 0, finalSignal!: AbortSignal;
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds: number) => {
    expect(milliseconds).toBe(15_000); deadline = new AbortController(); return deadline.signal;
  });
  context.onTestFinished(() => timeoutSpy.mockRestore());
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
  await expect(f.models.getAuth("devin")).rejects.toThrow(expect.toSatisfy((error: Error & { cause?: Error }) => error.cause?.name === "TimeoutError"));
  expect(finalSignal.aborted).toBe(true);
  expect(closed).toBe(1);
  expect(await f.storage.read("devin")).toStrictEqual(stored);
  await f.models.getAuth("devin");
  expect(calls).toBe(2); expect(closed).toBe(2);
});

test("cancelling Pi login stops the prompt and neither saves nor exchanges", async () => {
  const controller = new AbortController(); let inputSignal!: AbortSignal, exchanges = 0;
  const auth = createDevinAccountAuth({ loginOptions: { fetch: async () => { exchanges++; expect.unreachable(); } } });
  const f = host(auth);
  await expect(f.models.login("devin", "oauth", {
    signal: controller.signal, notify: () => {},
    prompt: async (prompt) => {
      if (prompt.type === "select") return "manual";
      inputSignal = prompt.signal!;
      controller.abort();
      return new Promise(() => {});
    },
  })).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  expect(inputSignal.aborted).toBe(true);
  expect(exchanges).toBe(0);
  expect(await f.storage.read("devin")).toBe(undefined);
});
