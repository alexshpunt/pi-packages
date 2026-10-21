import { expect, test } from "vitest";
import {
  createModels, InMemoryCredentialStore,
  type Credential, type OAuthCredential, type Provider,
} from "@earendil-works/pi-ai";

const credential: OAuthCredential = { type: "oauth", access: "contract-only-fake-session", refresh: "", expires: 0 };

function fixture(refresh: (current: OAuthCredential, signal: AbortSignal) => Promise<OAuthCredential>) {
  const storage = new InMemoryCredentialStore();
  let mutations = 0;
  const models = createModels({
    credentials: {
      read: storage.read.bind(storage), list: storage.list.bind(storage), delete: storage.delete.bind(storage),
      modify: (id, fn, options) => storage.modify(id, async (current) => {
        const result = await fn(current); if (result !== undefined) mutations++; return result;
      }, options),
    },
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const phases: boolean[] = [];
  const provider: Provider = {
    id: "devin-contract", name: "Devin contract", getModels: () => [],
    auth: { oauth: {
      name: "Devin account", login: async () => ({ ...credential }), refresh,
      toAuth: async (current) => ({ apiKey: current.access }),
    } },
    refreshModels: async (context) => { phases.push(context.allowNetwork); },
    stream: () => { throw new Error("No inference in auth contract check"); },
    streamSimple: () => { throw new Error("No inference in auth contract check"); },
  };
  models.setProvider(provider);
  return { models, storage, phases, mutations: () => mutations };
}

// 0 is what this adapter stored up to 0.1.4: Pi checks such a session on every resolve. It is not a server TTL.
test("Pi 1.3 public OAuth: resolving expires=0 is bounded and an explicit validity guarantee is rejected", async () => {
  let refreshes = 0;
  const f = fixture(async (current) => { refreshes++; return current; });
  const result = await f.models.login("devin-contract", "oauth", {
    notify: () => {}, prompt: async () => { throw new Error("No real interaction"); },
  });
  expect(result).toStrictEqual(credential);
  expect(f.models.getProvider("devin-contract")?.auth.apiKey).toBe(undefined);
  expect((await f.models.checkAuth("devin-contract"))?.type).toBe("oauth");
  expect(refreshes).toBe(0);
  for (const auth of await Promise.all([1, 2, 3].map(() => f.models.getAuth("devin-contract")))) {
    expect(auth?.auth.apiKey).toBe(credential.access);
  }
  expect(refreshes).toBe(3);
  expect(f.mutations()).toBe(4); // login 1 + explicit auth resolution 3; no background loop.
  expect(await f.storage.read("devin-contract")).toStrictEqual(credential);
  await expect(f.models.getAuth("devin-contract", { minOAuthValidityMs: 1 })).rejects.toThrow(/expires too soon/);
  expect(refreshes).toBe(4);
  expect(f.mutations()).toBe(5);
  await f.models.refresh({ allowNetwork: false });
  expect(f.phases).toStrictEqual([false]);
  expect(refreshes).toBe(4);
  await f.models.refresh({ allowNetwork: true });
  expect(f.phases).toStrictEqual([false, false, true]);
  expect(refreshes).toBe(5);
  await f.models.logout("devin-contract");
  expect(await f.models.getAuth("devin-contract")).toBe(undefined);
  expect(refreshes).toBe(5);
});

test("a refresh started by Pi completes and saves with its own signal after caller cancellation and is serialized with logout", async () => {
  let start!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const released = new Promise<void>((resolve) => { finish = resolve; });
  let refreshSignal: AbortSignal | undefined;
  const f = fixture(async (current, signal) => { refreshSignal = signal; start(); await released; return current; });
  await f.storage.modify("devin-contract", async (): Promise<Credential> => ({ ...credential }));
  const controller = new AbortController();
  const auth = f.models.getAuth("devin-contract", { signal: controller.signal });
  await started;
  controller.abort(new DOMException("cancel", "AbortError"));
  await expect(auth).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  expect(refreshSignal!.aborted).toBe(false); // Host's 15000ms signal, not an overwritten caller signal.
  const logout = f.models.logout("devin-contract");
  finish();
  await logout;
  expect(f.mutations()).toBe(1);
  expect(await f.storage.read("devin-contract")).toBe(undefined);
});
