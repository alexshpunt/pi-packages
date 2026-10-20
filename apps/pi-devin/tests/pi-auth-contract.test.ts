import assert from "node:assert/strict";
import { test } from "node:test";
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

// 0 is this adapter's 'server expiry unknown, check on every resolve' sentinel. It is not a server TTL.
test("Pi 1.3 public OAuth: resolving expires=0 is bounded and an explicit validity guarantee is rejected", async () => {
  let refreshes = 0;
  const f = fixture(async (current) => { refreshes++; return current; });
  const result = await f.models.login("devin-contract", "oauth", {
    notify: () => {}, prompt: async () => { throw new Error("No real interaction"); },
  });
  assert.deepEqual(result, credential);
  assert.equal(f.models.getProvider("devin-contract")?.auth.apiKey, undefined);
  assert.equal((await f.models.checkAuth("devin-contract"))?.type, "oauth");
  assert.equal(refreshes, 0);
  for (const auth of await Promise.all([1, 2, 3].map(() => f.models.getAuth("devin-contract")))) {
    assert.equal(auth?.auth.apiKey, credential.access);
  }
  assert.equal(refreshes, 3);
  assert.equal(f.mutations(), 4); // login 1 + explicit auth resolution 3; no background loop.
  assert.deepEqual(await f.storage.read("devin-contract"), credential);
  await assert.rejects(f.models.getAuth("devin-contract", { minOAuthValidityMs: 1 }), /expires too soon/);
  assert.equal(refreshes, 4);
  assert.equal(f.mutations(), 5);
  await f.models.refresh({ allowNetwork: false });
  assert.deepEqual(f.phases, [false]);
  assert.equal(refreshes, 4);
  await f.models.refresh({ allowNetwork: true });
  assert.deepEqual(f.phases, [false, false, true]);
  assert.equal(refreshes, 5);
  await f.models.logout("devin-contract");
  assert.equal(await f.models.getAuth("devin-contract"), undefined);
  assert.equal(refreshes, 5);
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
  await assert.rejects(auth, { name: "AbortError" });
  assert.equal(refreshSignal!.aborted, false); // Host's 15000ms signal, not an overwritten caller signal.
  const logout = f.models.logout("devin-contract");
  finish();
  await logout;
  assert.equal(f.mutations(), 1);
  assert.equal(await f.storage.read("devin-contract"), undefined);
});
