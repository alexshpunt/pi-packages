import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createModels, getSupportedThinkingLevels, InMemoryCredentialStore, InMemoryModelsStore, type Credential as HostCredential, type ModelsPublication, type ModelsStoreEntry, type Provider, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { createDevinModelSource, DEVIN_API, FUSION_MODEL_ID, type FusionSelection } from "../src/pi/models.ts";
import { parseModelCatalog } from "../src/core/models/catalog.ts";
import type { EffectiveThinkingLevel } from "../src/core/models/variants.ts";
import { DevinClient } from "../src/core/client.ts";
import { createFingerprintProvider } from "../src/core/protocol/fingerprint.ts";
import type { JsonObject } from "../src/core/types.ts";
import { credential, identity, MODELS_METHOD, requestBody, unaryResponse } from "./helpers.ts";

const raw = JSON.parse(await readFile(new URL("./fixtures/model-catalog.json", import.meta.url), "utf8")) as JsonObject;
const hostCredential: HostCredential = { type: "oauth", access: credential.sessionToken, refresh: "", expires: 0 };
const credentialFromHost = (value: HostCredential | undefined) => value?.type === "oauth" ? { ...credential, sessionToken: value.access } : undefined;
function publications() {
  let stored: ModelsStoreEntry | undefined;
  const history: ModelsPublication[] = [];
  return { history, stored: () => stored, context(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
    return { credential: hostCredential, stored, signal: new AbortController().signal, allowNetwork: true,
      publish: async (publication) => {
        history.push(publication);
        if (publication.persist !== undefined) stored = publication.persist === null ? undefined : structuredClone(publication.persist);
        publication.update?.(); return true;
      }, ...overrides,
    };
  } };
}

test("factory/getModels needs no auth or network, and the real catalog RPC consumes the credential, endpoint and signal", async () => {
  let loads = 0, resolutions = 0, selection: FusionSelection | undefined;
  const source = createDevinModelSource({ credentialFromHost: (value) => { resolutions++; return credentialFromHost(value); },
    fusion: () => selection,
    fetchCatalog: async (value, signal) => {
      loads++;
      const client = new DevinClient(value, { fingerprint: createFingerprintProvider(value.sessionToken, { collectIdentity: () => identity }),
        fetch: async (url, init) => {
          assert.equal(String(url), "https://override.invalid/" + MODELS_METHOD);
          assert.equal(new Headers(init!.headers).get("authorization"), `Basic ${credential.sessionToken}-${credential.sessionToken}`);
          assert.equal((requestBody(MODELS_METHOD, init!).metadata as JsonObject).apiKey, credential.sessionToken);
          assert.equal(init!.signal!.aborted, false);
          return unaryResponse(MODELS_METHOD, raw);
        },
      });
      try { return await client.catalog(signal); } finally { client.transport.close(); }
    },
  });
  assert.deepEqual(source.getModels(), []); assert.equal(resolutions, 0); assert.equal(loads, 0);
  const p = publications();
  await source.refreshModels(p.context({ credential: undefined, allowNetwork: false }));
  assert.equal(loads, 0);
  await source.refreshModels(p.context({ baseUrl: "https://override.invalid" }));
  assert.equal(loads, 1); assert.equal(source.getModels().length, 66);
  const scoped = { ...credential, apiServerURL: "https://override.invalid" };
  // Both listed group IDs and hidden variant IDs (catalog UIDs) resolve.
  assert.equal(source.resolve("swe-2", "high", scoped).uid, "swe-2-high");
  assert.equal(source.resolve("swe-2-medium", "medium", scoped).uid, "swe-2-medium");
  assert.equal(source.resolveUID("swe-2-max", scoped).uid, "swe-2-max");
  assert.throws(() => source.resolveUID("missing-uid", scoped), /Model UID unavailable/);
  assert.throws(() => source.resolve("swe-2-medium", "medium", credential), /account and endpoint/);
  // The Fusion choice resolves to the same exact UID as the current lead group. Changing the choice rebuilds without network.
  const leadOf = () => source.getModels().find((model) => model.id === FUSION_MODEL_ID)!.devin.fusion!.leadID;
  const sameAsLead = () => {
    const fusion = source.getModels().find((model) => model.id === FUSION_MODEL_ID)!;
    for (const level of getSupportedThinkingLevels(fusion) as EffectiveThinkingLevel[]) {
      assert.equal(source.resolve(FUSION_MODEL_ID, level, scoped).uid, source.resolve(leadOf(), level, scoped).uid);
    }
    return getSupportedThinkingLevels(fusion);
  };
  assert.deepEqual(sameAsLead(), ["medium", "high", "max"]);
  const choices = source.getFusionChoices()!;
  const sol = choices.leads.find((item) => item.id === "gpt-5.6-sol")!;
  selection = { leadID: sol.id, sidekickID: "swe-2-high" };
  source.rebuildModels();
  assert.equal(loads, 1);
  assert.equal(leadOf(), sol.id);
  assert.equal(source.getModels().find((model) => model.id === FUSION_MODEL_ID)!.name, "Devin Fusion · GPT-5.6 Sol + SWE-2 High");
  // An exact UID hidden from the list still has a level and resolves when the catalog has it.
  assert.equal(source.exactLevel("swe-2-high"), "high"); assert.equal(source.exactLevel("missing-uid"), undefined);
  assert.deepEqual(sameAsLead(), ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.throws(() => source.resolve("not-a-model", "medium", scoped), /unavailable/);
});

test("the persisted catalog holds only allowed fields and restores offline for the same credential and endpoint", async () => {
  let calls = 0;
  const poisoned = structuredClone(raw);
  poisoned.metadata = { apiKey: "private-raw-key", f: "private-raw-fingerprint", modelAssignmentJwt: "private-raw-jwt" };
  const options = { credentialFromHost, now: () => 1000, fetchCatalog: async () => { calls++; return parseModelCatalog(poisoned); } };
  const source = createDevinModelSource(options), p = publications();
  await source.refreshModels(p.context());
  const saved = p.stored()!;
  const serialized = JSON.stringify(saved);
  for (const forbidden of [credential.sessionToken, "private-raw-key", "private-raw-fingerprint", "private-raw-jwt"]) assert.equal(serialized.includes(forbidden), false);
  const restored = createDevinModelSource(options);
  await restored.refreshModels(p.context({ allowNetwork: false, stored: saved }));
  assert.deepEqual(restored.getModels(), source.getModels());
  assert.equal(restored.getUnsupported().length, 4);
  await restored.refreshModels(p.context({ stored: saved }));
  assert.equal(calls, 1);
  await restored.refreshModels(p.context({ stored: saved, force: true }));
  assert.equal(calls, 2);
  // Even when saved with the recommended filter on, the stored list holds the whole catalog. The filter is applied again after restore.
  let isRecommendedOnly = true;
  const filteredOptions = { ...options, recommendedOnly: () => isRecommendedOnly }, q = publications();
  const filtered = createDevinModelSource(filteredOptions);
  await filtered.refreshModels(q.context());
  assert.equal(filtered.getModels().length, 16);
  assert.equal(q.stored()!.models.length, 66);
  const afterRestart = createDevinModelSource(filteredOptions);
  await afterRestart.refreshModels(q.context({ allowNetwork: false, stored: q.stored() }));
  assert.equal(afterRestart.getModels().length, 16);
  isRecommendedOnly = false;
  afterRestart.rebuildModels();
  assert.deepEqual(afterRestart.getModels().map((model) => model.id), source.getModels().map((model) => model.id));
  // The sidekick child Pi uses every exact UID, but the shared stored list keeps only the default list. A lead restoring it gets no sidekick-only entries.
  const childOptions = { ...options, fusion: false as const, listsAllExactModels: true }, r = publications();
  const child = createDevinModelSource(childOptions);
  await child.refreshModels(r.context());
  assert.equal(child.getModels().length, 326);
  const shared = r.stored()!.models.map((model) => model.id);
  assert.deepEqual([shared.length, shared.includes("swe-2-high"), shared.includes("swe-2")], [65, false, true]);
  const lead = createDevinModelSource(options);
  await lead.refreshModels(r.context({ allowNetwork: false, stored: r.stored() }));
  assert.deepEqual(lead.getModels().map((model) => model.id), source.getModels().map((model) => model.id));
  const childAgain = createDevinModelSource(childOptions);
  await childAgain.refreshModels(r.context({ allowNetwork: false, stored: r.stored() }));
  assert.equal(childAgain.getModels().length, 326);
});

test("after an account or endpoint change or logout, the old list is not exposed as authorized models", async () => {
  const source = createDevinModelSource({ credentialFromHost, fetchCatalog: async () => parseModelCatalog(raw) });
  const p = publications(); await source.refreshModels(p.context());
  const oldModels = source.getModels(), saved = p.stored()!;
  const other = { ...hostCredential, access: "different-fake-account" } as HostCredential;
  assert.deepEqual(source.filterModels(oldModels, other), []);
  await source.refreshModels(p.context({ credential: other, stored: saved, allowNetwork: false }));
  assert.deepEqual(source.getModels(), []);
  await source.refreshModels(p.context({ credential: hostCredential, baseUrl: "https://other.invalid", stored: saved, allowNetwork: false }));
  assert.deepEqual(source.getModels(), []);
  // Removing the override does not implicitly reuse the previous one.
  await source.refreshModels(p.context({ credential: hostCredential, baseUrl: undefined, stored: saved, allowNetwork: false }));
  assert.equal(source.getModels().length, 66);
  await source.refreshModels(p.context({ credential: undefined, allowNetwork: false }));
  assert.deepEqual(source.getModels(), []);
  assert.deepEqual(source.filterModels(oldModels, undefined), []);
});

test("forced and expired refreshes, last-good on failure, and new disabled permissions apply", async () => {
  let now = 1000, calls = 0, failure = false, disabled = false;
  const source = createDevinModelSource({ credentialFromHost, now: () => now, fetchCatalog: async () => {
    calls++; if (failure) throw new Error("temporary offline");
    const value = structuredClone(raw);
    if (disabled) (value.clientModelConfigs as JsonObject[]).find((config) => config.modelUid === "swe-2-medium")!.disabled = true;
    return parseModelCatalog(value);
  } });
  const p = publications(); await source.refreshModels(p.context());
  const before = source.getModels();
  await source.refreshModels(p.context()); assert.equal(calls, 1);
  failure = true;
  await assert.rejects(source.refreshModels(p.context({ force: true })), /temporary offline/);
  assert.equal(source.getModels(), before);
  failure = false; disabled = true; now += 300_001;
  await source.refreshModels(p.context());
  assert.equal(calls, 3);
  assert.throws(() => source.resolve("swe-2-medium", "medium", credential));
  assert.equal(source.getModels().some((model) => model.id === "swe-2-medium"), false);
});

test("late responses after cancel and rejected publishes do not change the last good list", async () => {
  let resolve!: (value: ReturnType<typeof parseModelCatalog>) => void, isDeferred = false;
  const source = createDevinModelSource({ credentialFromHost, fetchCatalog: async () => isDeferred ? new Promise((done) => { resolve = done; }) : parseModelCatalog(raw) });
  const p = publications(); await source.refreshModels(p.context());
  const before = source.getModels(), publicationsBefore = p.history.length;
  isDeferred = true;
  const controller = new AbortController();
  const pending = source.refreshModels(p.context({ force: true, signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" }); // Returns even though fetchCatalog has not finished yet.
  resolve(parseModelCatalog({ clientModelConfigs: [] }));
  await Promise.resolve();
  assert.equal(source.getModels(), before); assert.equal(p.history.length, publicationsBefore);
  isDeferred = false;
  await source.refreshModels(p.context({ force: true, publish: async () => false }));
  assert.equal(source.getModels(), before);
});

test("public Models publish/persist and cache restore keep the extension metadata", async () => {
  const credentials = new InMemoryCredentialStore(), store = new InMemoryModelsStore();
  await credentials.modify("devin", async () => hostCredential);
  let calls = 0;
  const options = { credentialFromHost, fetchCatalog: async () => { calls++; return parseModelCatalog(raw); } };
  const createProvider = (source: ReturnType<typeof createDevinModelSource>): Provider<typeof DEVIN_API> => ({
    id: "devin", name: "Devin", getModels: source.getModels, filterModels: source.filterModels, refreshModels: source.refreshModels,
    auth: { oauth: { name: "fake", login: async () => { throw new Error("No login"); }, refresh: async (value) => value, toAuth: async (value) => ({ apiKey: value.access }) } },
    stream: () => { throw new Error("No inference"); }, streamSimple: () => { throw new Error("No inference"); },
  });
  const models = createModels({ credentials, modelsStore: store, authContext: { env: async () => undefined, fileExists: async () => false } });
  const first = createDevinModelSource(options); models.setProvider(createProvider(first));
  assert.equal((await models.refresh({ allowNetwork: true })).errors.size, 0);
  assert.equal(models.getModels("devin").length, 66); assert.equal(calls, 1);
  const second = createDevinModelSource(options); models.setProvider(createProvider(second));
  assert.equal((await models.refresh({ allowNetwork: false })).errors.size, 0);
  assert.deepEqual(second.getModels(), first.getModels());
  assert.equal((await models.getAvailable("devin")).length, 66);
  await models.logout("devin");
  await models.refresh({ allowNetwork: false });
  assert.deepEqual(models.getModels("devin"), []);
  assert.equal(calls, 1);
});
