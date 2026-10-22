import { expect, test, vi, type TestContext } from "vitest";
import { createModels, InMemoryCredentialStore, type AuthInteraction, type CredentialStore, type OAuthAuth, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { RPCError } from "../src/core/errors.ts";
import { Accounts } from "../src/pi/features/accounts/service.ts";
import { credentialFromOAuth, SESSION_CHECK_INTERVAL_MS } from "../src/pi/features/auth/credential.ts";
import { CredentialGuard } from "../src/pi/features/auth/guard.ts";
import { AuthState } from "../src/pi/features/auth/state.ts";
import { countingTransport, makeTestProvider, type TestOptions, type TestProvider } from "./extension-harness.ts";
import { requestBody, runSync, STATUS_METHOD, statusResponse, unaryResponse } from "./helpers.ts";

/** Pi's public `Models` with a stub provider that carries only the real OAuth adapter, as Pi's auth layer sees it. */
function host(oauth: OAuthAuth, storage: CredentialStore = new InMemoryCredentialStore()) {
  const models = createModels({ credentials: storage, authContext: {
    env: async () => { throw new Error("OAuth must not read environment keys"); }, fileExists: async () => false,
  } });
  const phases: boolean[] = [];
  const stub = (auth: OAuthAuth): Provider => ({
    id: "devin", name: "Devin", auth: { oauth: auth }, getModels: () => [],
    refreshModels: async (context) => { phases.push(context.allowNetwork); },
    stream: () => { throw new Error("No inference in auth test"); },
    streamSimple: () => { throw new Error("No inference in auth test"); },
  });
  models.setProvider(stub(oauth));
  /** Pi loads the provider again, as after a restart: the new instance has not checked any account yet. */
  const restart = (next: OAuthAuth) => { models.setProvider(stub(next)); };
  return { models, storage, phases, restart };
}

/** Only `Date` is faked, so the session check becomes due by moving the clock past the check interval. */
function fakeClock(context: TestContext) {
  vi.useFakeTimers({ toFake: ["Date"] }); context.onTestFinished(() => { vi.useRealTimers(); });
  return { passCheckInterval: () => { vi.setSystemTime(Date.now() + SESSION_CHECK_INTERVAL_MS); } };
}

function manualInteraction(signal?: AbortSignal): AuthInteraction {
  return {
    signal, notify: () => {},
    prompt: async (prompt) => prompt.type === "select" ? "manual" : "wspkce$manual-fake-code",
  };
}

const providers: TestProvider[] = [];
const open = (options: TestOptions) => { const opened = makeTestProvider(options); providers.push(opened); return opened; };
const oauthOf = (opened: TestProvider) => opened.provider.auth.oauth!;

/** Counts account status lookups (sends), their closed clients and code exchanges across every provider instance of a test. */
function accountFixture() {
  let status = 200, sends = 0, closed = 0, exchanges = 0;
  const sessionToken = "fake-account-session";
  const options: TestOptions = {
    loginOptions: { fetch: async (url, init) => {
      exchanges++;
      const method = new URL(String(url)).pathname.slice(1);
      expect(method.endsWith("/ExchangePKCEAuthorizationCode")).toBe(true);
      expect(requestBody(method, init!).authorizationCode).toBe("manual-fake-code");
      return unaryResponse(method, { apiKey: sessionToken });
    } },
    transport: countingTransport(async (url, init) => {
      sends++;
      expect(new URL(String(url)).pathname).toBe("/" + STATUS_METHOD);
      expect(new Headers(init!.headers).get("authorization")).toBe(`Basic ${sessionToken}-${sessionToken}`);
      const body = requestBody(STATUS_METHOD, init!);
      expect((body.metadata as { apiKey: string }).apiKey).toBe(sessionToken);
      return status === 200 ? unaryResponse(STATUS_METHOD, statusResponse()) : Response.json({}, { status });
    }, () => { closed++; }),
  };
  const first = open(options);
  return {
    first, options, host: host(oauthOf(first)), setStatus: (next: number) => { status = next; }, counts: () => ({ sends, closed, exchanges }),
    /** A new provider instance with the same transports, as a restarted Pi would load. */
    restart: () => open(options),
  };
}

test("real OAuth adapter → public Models login, repeated resolve, a check after the interval, model refresh and logout", async (context) => {
  const clock = fakeClock(context);
  const f = accountFixture();
  try {
    const loggedIn = await f.host.models.login("devin", "oauth", manualInteraction());
    expect(loggedIn.type).toBe("oauth");
    if (loggedIn.type !== "oauth") expect.unreachable();
    expect(loggedIn.expires).toBe(Date.now() + SESSION_CHECK_INTERVAL_MS);
    expect(loggedIn.refresh).toBe("");
    // Sign-in records the new session's account once; it is not a permission check and does not wait for one.
    expect(f.counts()).toStrictEqual({ sends: 1, closed: 1, exchanges: 1 });
    expect((await f.host.models.checkAuth("devin"))?.type).toBe("oauth");
    const auth = await f.host.models.getAuth("devin");
    expect(auth?.auth.apiKey).toBe(loggedIn.access);
    expect(auth?.auth.baseUrl).toBe("https://server.codeium.com");
    const repeated = await Promise.all([f.host.models.getAuth("devin"), f.host.models.getAuth("devin")]);
    expect(repeated.every((value) => value?.auth.apiKey === loggedIn.access)).toBe(true);
    // Within the interval, resolving and model refreshes neither check the session nor save a credential.
    expect(await f.host.storage.read("devin")).toStrictEqual(loggedIn);
    await f.host.models.refresh({ allowNetwork: false });
    await f.host.models.refresh({ allowNetwork: true });
    expect(f.host.phases).toStrictEqual([false, false, true]);
    expect(f.counts()).toStrictEqual({ sends: 1, closed: 1, exchanges: 1 });
    // After the interval, a process that already checked the account saves only the next check time, without the network.
    clock.passCheckInterval();
    await Promise.all([f.host.models.getAuth("devin"), f.host.models.getAuth("devin")]);
    expect(f.counts()).toStrictEqual({ sends: 1, closed: 1, exchanges: 1 });
    expect(await f.host.storage.read("devin")).toStrictEqual({ ...loggedIn, expires: Date.now() + SESSION_CHECK_INTERVAL_MS });
    // A restarted process has not checked the account: once the interval passes, concurrent resolves check the session once.
    f.host.restart(oauthOf(f.restart()));
    clock.passCheckInterval();
    const checked = await Promise.all([f.host.models.getAuth("devin"), f.host.models.getAuth("devin")]);
    expect(checked.every((value) => value?.auth.apiKey === loggedIn.access)).toBe(true);
    expect(f.counts()).toStrictEqual({ sends: 2, closed: 2, exchanges: 1 });
    expect(await f.host.storage.read("devin")).toStrictEqual({ ...loggedIn, expires: Date.now() + SESSION_CHECK_INTERVAL_MS });
    await f.host.models.logout("devin");
    expect(await f.host.models.getAuth("devin")).toBe(undefined);
    expect(f.counts()).toStrictEqual({ sends: 2, closed: 2, exchanges: 1 });
  } finally { for (const opened of providers.splice(0)) opened.shutdown(); }
});

test("a 401 session is not replayed automatically and an explicit re-login creates a new client", async (context) => {
  const clock = fakeClock(context);
  const f = accountFixture();
  try {
    const loggedIn = await f.host.models.login("devin", "oauth", manualInteraction());
    // The account was checked at sign-in, so only a process that has not checked it sends the session check that meets the 401.
    const restarted = f.restart();
    f.host.restart(oauthOf(restarted));
    clock.passCheckInterval();
    f.setStatus(401);
    await expect(f.host.models.getAuth("devin")).rejects.toThrow(expect.toSatisfy((error: Error & { cause?: unknown }) => error.cause instanceof RPCError && error.cause.kind === "authentication"));
    await expect(f.host.models.getAuth("devin")).rejects.toThrow(/OAuth refresh failed/);
    expect(f.counts()).toStrictEqual({ sends: 2, closed: 2, exchanges: 1 });
    expect(await f.host.storage.read("devin")).toStrictEqual(loggedIn);
    const previousGeneration = restarted.runtime.runSync(Effect.flatMap(AuthState, (auth) => auth.generation));
    f.setStatus(200);
    const renewed = await f.host.models.login("devin", "oauth", manualInteraction());
    expect(renewed.type).toBe("oauth");
    if (renewed.type !== "oauth") expect.unreachable();
    expect(f.counts()).toStrictEqual({ sends: 3, closed: 3, exchanges: 2 });
    // A late failure from an older login generation does not invalidate the new login.
    restarted.runtime.runSync(Effect.flatMap(CredentialGuard, (guard) =>
      guard.reportFailure(runSync(credentialFromOAuth(renewed)), RPCError.make("unauthenticated", "old failure"), previousGeneration)));
    expect((await f.host.models.getAuth("devin"))?.auth.apiKey).toBe(renewed.access);
    clock.passCheckInterval();
    expect((await f.host.models.getAuth("devin"))?.auth.apiKey).toBe(renewed.access);
    expect(f.counts()).toStrictEqual({ sends: 3, closed: 3, exchanges: 2 });
  } finally { for (const opened of providers.splice(0)) opened.shutdown(); }
});

for (const status of [200, 503]) test(`sign-in checks the new session once and a ${status} check ${status === 200 ? "records the account" : "does not fail sign-in"}`, async () => {
  let sends = 0;
  const opened = open({
    loginOptions: { fetch: async (url) => unaryResponse(new URL(String(url)).pathname.slice(1), { apiKey: "fake-checked-session" }) },
    fetch: async () => { sends++; return status === 200 ? unaryResponse(STATUS_METHOD, statusResponse()) : Response.json({}, { status }); },
  });
  try {
    const f = host(oauthOf(opened));
    const credential = await f.models.login("devin", "oauth", manualInteraction());
    expect(sends).toBe(1);
    const recorded = opened.runtime.runSync(Effect.flatMap(Accounts, (accounts) => accounts.get(runSync(credentialFromOAuth(credential as OAuthCredential)))));
    expect(recorded === undefined ? 0 : 1).toBe(status === 200 ? 1 : 0);
    expect(await f.storage.read("devin")).toStrictEqual(credential);
  } finally { opened.shutdown(); }
});

for (const status of [403, 429]) test(`${status} is not remembered as OAuth token expiry`, async (context) => {
  const clock = fakeClock(context);
  const f = accountFixture();
  try {
    await f.host.models.login("devin", "oauth", manualInteraction());
    f.host.restart(oauthOf(f.restart()));
    clock.passCheckInterval();
    f.setStatus(status);
    await expect(f.host.models.getAuth("devin")).rejects.toThrow();
    f.setStatus(200);
    await f.host.models.getAuth("devin");
    expect(f.counts()).toStrictEqual({ sends: 3, closed: 3, exchanges: 1 });
  } finally { for (const opened of providers.splice(0)) opened.shutdown(); }
});

function unreachableCheckFixture(firstFailure: () => Promise<Response>) {
  let calls = 0;
  const opened = open({ fetch: async () => (++calls === 1 ? firstFailure() : unaryResponse(STATUS_METHOD, statusResponse())) });
  const f = host(oauthOf(opened));
  const stored = { type: "oauth" as const, access: "fake-unreachable-token", refresh: "", expires: 0,
    devin: { version: 1, apiServerURL: "https://example.invalid", createdAt: "2026-01-01T00:00:00.000Z" } };
  return { f, stored, calls: () => calls, shutdown: () => opened.shutdown() };
}

const refused = () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }));
for (const [name, firstFailure] of [
  ["a refused connection", refused],
  ["a 503 response", () => Promise.resolve(Response.json({}, { status: 503 }))],
] as const) test(`${name} during the pre-request session check keeps the stored session`, async () => {
  const { f, stored, calls, shutdown } = unreachableCheckFixture(firstFailure);
  try {
    await f.storage.modify("devin", async () => stored);
    // The model request proceeds with the stored session instead of failing as "OAuth refresh failed".
    expect((await f.models.getAuth("devin"))?.auth.apiKey).toBe(stored.access);
    expect(await f.storage.read("devin")).toStrictEqual(stored);
    // Not remembered as an authentication failure: the next request checks the session again.
    expect((await f.models.getAuth("devin"))?.auth.apiKey).toBe(stored.access);
    expect(calls()).toBe(2);
  } finally { shutdown(); }
});

test("a TLS failure during the session check still fails the request", async () => {
  const { f, stored, shutdown } = unreachableCheckFixture(() => Promise.reject(Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" })));
  try {
    await f.storage.modify("devin", async () => stored);
    await expect(f.models.getAuth("devin")).rejects.toThrow(/OAuth refresh failed/);
  } finally { shutdown(); }
});

test("Pi browser login and the callback/manual prompt race use the same shared REST exchange", async () => {
  let callback!: URL, promptSignal!: AbortSignal, request: Promise<Response> | undefined, exchanges = 0;
  const opened = open({
    loginOptions: { fetch: async (url, init) => {
      exchanges++;
      expect(String(url)).toBe("https://api.devin.ai/auth/cli/token");
      expect(JSON.parse(init!.body as string).code).toBe("pi-browser-code");
      return Response.json({ token: "pi.fake.session" });
    } },
    // The account check after sign-in goes to the session's API server, not to the code exchange.
    fetch: async () => unaryResponse(STATUS_METHOD, statusResponse()),
  });
  try {
    const f = host(oauthOf(opened));
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
  } finally { opened.shutdown(); }
});

test("the host 15000ms refresh signal ends the final status request and a local timeout is not remembered as auth expiry", async (context) => {
  let deadline!: AbortController, calls = 0, closed = 0, finalSignal!: AbortSignal;
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds: number) => {
    expect(milliseconds).toBe(15_000); deadline = new AbortController(); return deadline.signal;
  });
  context.onTestFinished(() => timeoutSpy.mockRestore());
  const opened = open({ transport: countingTransport(async (_url, init) => {
    calls++; finalSignal = init!.signal!;
    if (calls === 1) { deadline.abort(new DOMException("host timeout", "TimeoutError")); return new Promise(() => {}); }
    return unaryResponse(STATUS_METHOD, statusResponse());
  }, () => { closed++; }) });
  try {
    const f = host(oauthOf(opened));
    const stored = { type: "oauth" as const, access: "fake-timeout-token", refresh: "", expires: 0,
      devin: { version: 1, apiServerURL: "https://example.invalid", createdAt: "2026-01-01T00:00:00.000Z" } };
    await f.storage.modify("devin", async () => stored);
    await expect(f.models.getAuth("devin")).rejects.toThrow(expect.toSatisfy((error: Error & { cause?: Error }) => error.cause?.name === "TimeoutError"));
    expect(finalSignal.aborted).toBe(true);
    expect(closed).toBe(1);
    expect(await f.storage.read("devin")).toStrictEqual(stored);
    await f.models.getAuth("devin");
    expect(calls).toBe(2); expect(closed).toBe(2);
  } finally { opened.shutdown(); }
});

test("cancelling Pi login stops the prompt and neither saves nor exchanges", async () => {
  const controller = new AbortController(); let inputSignal!: AbortSignal, exchanges = 0;
  const opened = open({ loginOptions: { fetch: async () => { exchanges++; expect.unreachable(); } } });
  try {
    const f = host(oauthOf(opened));
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
  } finally { opened.shutdown(); }
});
