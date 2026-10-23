import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore, type Provider } from "@earendil-works/pi-ai";
import { DEVIN_API } from "../src/pi/features/catalog/constants.ts";
import { makeTestCatalog, makeTestProvider } from "./extension-harness.ts";
import { parseModelCatalog } from "../src/core/models/catalog.ts";
import type { JsonObject } from "../src/core/types.ts";
import { credential, MODELS_METHOD, run, runSync, STATUS_METHOD, statusResponse, unaryResponse } from "./helpers.ts";
import { providerCredential, providerFixture } from "./provider-fixture.ts";

const raw = JSON.parse(await readFile(new URL("./fixtures/model-catalog.json", import.meta.url), "utf8"));

test("the real coding-agent catalog file is restored after restart and not applied to another credential", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-model-store-"));
  const path = join(directory, "models-cache.json"), credentials = new InMemoryCredentialStore();
  // Only the selected provider's fake loader is called. Any unnecessary global fetch fails.
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("External fetch forbidden in model store test"); });
  context.onTestFinished(() => fetchSpy.mockRestore());
  await credentials.modify("devin", async () => ({ type: "oauth", access: credential.sessionToken, refresh: "", expires: 0 }));
  let calls = 0;
  const createProvider = () => {
    let restored!: () => void;
    const ready = new Promise<void>((resolve) => { restored = resolve; });
    const source = makeTestCatalog({
      credentialFromHost: (value) => Effect.succeed(value?.type === "oauth" ? { ...credential, sessionToken: value.access } : undefined),
      fetchCatalog: () => Effect.suspend(() => { calls++; return parseModelCatalog(raw); }),
    });
    const provider: Provider<typeof DEVIN_API> = { id: "devin", name: "Devin", getModels: () => runSync(source.models),
      filterModels: (models, current) => runSync(source.filter(models, current)),
      refreshModels: async (context) => { await run(source.refresh(context)); if (!context.allowNetwork) restored(); },
      auth: { oauth: { name: "fixture", login: async () => { throw new Error("No login"); }, refresh: async (value) => value, toAuth: async (value) => ({ apiKey: value.access }) } },
      stream: () => { throw new Error("No inference"); }, streamSimple: () => { throw new Error("No inference"); },
    };
    return { provider, ready };
  };
  try {
    const first = await ModelRuntime.create({ credentials, modelsPath: join(directory, "models.json"), modelsStorePath: path, refreshOnCreate: false, allowModelNetwork: false });
    const initial = createProvider(); first.registerNativeProvider(initial.provider);
    await initial.ready; // Refresh explicitly after the async offline phase started by registerNativeProvider.
    const result = await first.refresh({ providers: ["devin"], allowNetwork: true, force: true });
    expect(result.aborted).toBe(false);
    expect(result.errors.size).toBe(0);
    expect(first.getModels("devin").length).toBe(66);
    expect(calls).toBe(1);
    expect((await readFile(path, "utf8")).includes(credential.sessionToken)).toBe(false);
    const second = await ModelRuntime.create({ credentials, modelsPath: join(directory, "models.json"), modelsStorePath: path, refreshOnCreate: false, allowModelNetwork: false });
    const replacement = createProvider(); second.registerNativeProvider(replacement.provider);
    await replacement.ready;
    const restored = await second.refresh({ providers: ["devin"], allowNetwork: false });
    expect(restored.aborted).toBe(false);
    expect(restored.errors.size).toBe(0);
    expect(second.getModels("devin")).toStrictEqual(first.getModels("devin"));
    expect(calls).toBe(1);
    await credentials.modify("devin", async () => ({ type: "oauth", access: "another-fake-session", refresh: "", expires: 0 }));
    await second.refresh({ providers: ["devin"], allowNetwork: false });
    expect(await second.getAvailable("devin")).toStrictEqual([]);
    expect(second.getModels("devin")).toStrictEqual([]);
    expect(calls).toBe(1);
    first.unregisterProvider("devin"); second.unregisterProvider("devin");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("signing in again to the same account lists the stored catalog at once; another account sees none until its own catalog loads", async () => {
  let userId = "offline-user-id", sessions = 0;
  const fixture = await providerFixture({ statusFailure: () => {
    const body = statusResponse() as { userStatus: JsonObject };
    body.userStatus.userId = userId;
    return unaryResponse(STATUS_METHOD, body);
  } });
  fixture.shutdown();
  // Every sign-in issues a new session token, as a real re-login does.
  const loginFetch: typeof fetch = async (url, init) => {
    const method = new URL(String(url)).pathname.slice(1);
    if (method.endsWith("/ExchangeDevinCLIPKCECode")) return unaryResponse(method, { sessionToken: `fake-session-${++sessions}` });
    if (method.endsWith("/ExchangePKCEAuthorizationCode")) return unaryResponse(method, { apiKey: `fake-session-${++sessions}`, apiServerUrl: providerCredential.apiServerURL });
    return fixture.dependencies.fetch(url, init);
  };
  const opened = makeTestProvider({ ...fixture.dependencies, loginOptions: { ...fixture.dependencies.loginOptions, fetch: loginFetch } }), { provider } = opened;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(provider);
  const login = () => runtime.login("devin", "oauth", { notify: () => {}, prompt: async (prompt) => prompt.type === "select" ? "manual" : "fake-code" });
  // The fixture already fetched a catalog for its own provider; only this runtime's fetches count.
  const fetched = () => fixture.requests.filter((request) => request.method === MODELS_METHOD).length, before = fetched();
  const catalogs = () => fetched() - before;
  try {
    await login();
    expect((await runtime.refresh({ providers: ["devin"], allowNetwork: true, force: true })).errors.size).toBe(0);
    const listed = (await runtime.getAvailable("devin")).map((model) => model.id);
    expect(listed.length).toBeGreaterThan(0);
    expect(catalogs()).toBe(1);
    await login();
    expect(sessions).toBe(2);
    expect((await runtime.getAvailable("devin")).map((model) => model.id)).toStrictEqual(listed);
    userId = "another-offline-user";
    await login();
    expect(await runtime.getAvailable("devin")).toStrictEqual([]);
    expect(catalogs()).toBe(1);
  } finally { opened.shutdown(); runtime.unregisterProvider("devin"); }
});
