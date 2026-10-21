import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { createDevinModelSource, DEVIN_API } from "../src/pi/models.ts";
import { parseModelCatalog } from "../src/core/models/catalog.ts";
import { credential } from "./helpers.ts";

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
    const source = createDevinModelSource({
      credentialFromHost: (value) => value?.type === "oauth" ? { ...credential, sessionToken: value.access } : undefined,
      fetchCatalog: async () => { calls++; return parseModelCatalog(raw); },
    });
    const provider: Provider<typeof DEVIN_API> = { id: "devin", name: "Devin", getModels: source.getModels, filterModels: source.filterModels,
      refreshModels: async (context) => { await source.refreshModels(context); if (!context.allowNetwork) restored(); },
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
