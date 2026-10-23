import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { createModels, getSupportedThinkingLevels, InMemoryCredentialStore, InMemoryModelsStore, type Credential as HostCredential, type ModelsPublication, type ModelsStoreEntry, type Provider, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { DEVIN_API, FUSION_MODEL_ID } from "../src/pi/features/catalog/constants.ts";
import type { DevinModel, FusionSelection, ModelCatalogShape } from "../src/pi/features/catalog/types.ts";
import { parseModelCatalog, type ModelCatalog } from "../src/core/models/catalog.ts";
import type { EffectiveThinkingLevel } from "../src/core/models/variants.ts";
import { makeDevinClient } from "../src/core/client.ts";
import type { JsonObject } from "../src/core/types.ts";
import { failWith } from "../src/core/validation.ts";
import { makeTestCatalog, type TestCatalogOptions } from "./extension-harness.ts";
import { credential, fromAsync, MODELS_METHOD, requestBody, run, runSync, unaryResponse, withTransport } from "./helpers.ts";

const raw = JSON.parse(await readFile(new URL("./fixtures/model-catalog.json", import.meta.url), "utf8")) as JsonObject;
const hostCredential: HostCredential = { type: "oauth", access: credential.sessionToken, refresh: "", expires: 0 };
const credentialFromHost = (value: HostCredential | undefined) => Effect.succeed(value?.type === "oauth" ? { ...credential, sessionToken: value.access } : undefined);
const createSource = (options: TestCatalogOptions) => makeTestCatalog(options);
/** Pi passes its signal in the context; the catalog stops the refresh with it. */
const refresh = (source: ModelCatalogShape, context: RefreshModelsContext) => run(source.refresh(context));
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
  const source = createSource({ credentialFromHost: (value) => Effect.suspend(() => { resolutions++; return credentialFromHost(value); }),
    fusion: Effect.sync(() => selection),
    fetchCatalog: (value) => Effect.scoped(Effect.gen(function* () {
      loads++;
      const client = yield* makeDevinClient(value).pipe(withTransport({
        fetch: async (url, init) => {
          expect(String(url)).toBe("https://override.invalid/" + MODELS_METHOD);
          expect(new Headers(init!.headers).get("authorization")).toBe(`Basic ${credential.sessionToken}-${credential.sessionToken}`);
          expect((requestBody(MODELS_METHOD, init!).metadata as JsonObject).apiKey).toBe(credential.sessionToken);
          expect(init!.signal!.aborted).toBe(false);
          return unaryResponse(MODELS_METHOD, raw);
        },
      }));
      return yield* client.catalog;
    })),
  });
  expect(runSync(source.models)).toStrictEqual([]); expect(resolutions).toBe(0); expect(loads).toBe(0);
  const p = publications();
  await refresh(source, p.context({ credential: undefined, allowNetwork: false }));
  expect(loads).toBe(0);
  await refresh(source, p.context({ baseUrl: "https://override.invalid" }));
  expect(loads).toBe(1); expect(runSync(source.models).length).toBe(66);
  const scoped = { ...credential, apiServerURL: "https://override.invalid" };
  // Both listed group IDs and hidden variant IDs (catalog UIDs) resolve.
  expect(runSync(source.resolve("swe-2", "high", scoped)).uid).toBe("swe-2-high");
  expect(runSync(source.resolve("swe-2-medium", "medium", scoped)).uid).toBe("swe-2-medium");
  expect(runSync(source.resolveUID("swe-2-max", scoped)).uid).toBe("swe-2-max");
  expect(() => runSync(source.resolveUID("missing-uid", scoped))).toThrow(/Model UID unavailable/);
  expect(() => runSync(source.resolve("swe-2-medium", "medium", credential))).toThrow(/account and endpoint/);
  // The Fusion choice resolves to the same exact UID as the current lead group. Changing the choice rebuilds without network.
  const leadOf = () => runSync(source.models).find((model) => model.id === FUSION_MODEL_ID)!.devin.fusion!.leadID;
  const sameAsLead = () => {
    const fusion = runSync(source.models).find((model) => model.id === FUSION_MODEL_ID)!;
    for (const level of getSupportedThinkingLevels(fusion) as EffectiveThinkingLevel[]) {
      expect(runSync(source.resolve(FUSION_MODEL_ID, level, scoped)).uid).toBe(runSync(source.resolve(leadOf(), level, scoped)).uid);
    }
    return getSupportedThinkingLevels(fusion);
  };
  expect(sameAsLead()).toStrictEqual(["medium", "high", "max"]);
  const choices = runSync(source.fusionChoices)!;
  const sol = choices.leads.find((item) => item.id === "gpt-5.6-sol")!;
  selection = { leadID: sol.id, sidekickID: "swe-2-high" };
  runSync(source.rebuild);
  expect(loads).toBe(1);
  expect(leadOf()).toBe(sol.id);
  expect(runSync(source.models).find((model) => model.id === FUSION_MODEL_ID)!.name).toBe("Devin Fusion · GPT-5.6 Sol + SWE-2 High");
  // An exact UID hidden from the list still has a level and resolves when the catalog has it.
  expect(runSync(source.exactLevel("swe-2-high"))).toBe("high"); expect(runSync(source.exactLevel("missing-uid"))).toBe(undefined);
  expect(sameAsLead()).toStrictEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  expect(() => runSync(source.resolve("not-a-model", "medium", scoped))).toThrow(/unavailable/);
});

test("the persisted catalog holds only allowed fields and restores offline for the same credential and endpoint", async () => {
  let calls = 0;
  const poisoned = structuredClone(raw);
  poisoned.metadata = { apiKey: "private-raw-key", f: "private-raw-fingerprint", modelAssignmentJwt: "private-raw-jwt" };
  const options = { credentialFromHost, now: () => 1000, fetchCatalog: () => Effect.suspend(() => { calls++; return parseModelCatalog(poisoned); }) };
  const source = createSource(options), p = publications();
  await refresh(source, p.context());
  const saved = p.stored()!;
  const serialized = JSON.stringify(saved);
  for (const forbidden of [credential.sessionToken, "private-raw-key", "private-raw-fingerprint", "private-raw-jwt"]) expect(serialized.includes(forbidden)).toBe(false);
  const restored = createSource(options);
  await refresh(restored, p.context({ allowNetwork: false, stored: saved }));
  expect(runSync(restored.models)).toStrictEqual(runSync(source.models));
  expect(runSync(restored.unsupported).length).toBe(4);
  await refresh(restored, p.context({ stored: saved }));
  expect(calls).toBe(1);
  await refresh(restored, p.context({ stored: saved, force: true }));
  expect(calls).toBe(2);
  // Even when saved with the recommended filter on, the stored list holds the whole catalog. The filter is applied again after restore.
  let isRecommendedOnly = true;
  const filteredOptions = { ...options, recommendedOnly: Effect.sync(() => isRecommendedOnly) }, q = publications();
  const filtered = createSource(filteredOptions);
  await refresh(filtered, q.context());
  // The filter keeps the default list's recommended groups and Fusion.
  const recommendedIDs = runSync(source.models).filter((model) => model.devin.recommended === true || model.devin.fusion).map((model) => model.id);
  expect(recommendedIDs.length > 1 && recommendedIDs.length < runSync(source.models).length).toBeTruthy();
  expect(runSync(filtered.models).map((model) => model.id)).toStrictEqual(recommendedIDs);
  expect(q.stored()!.models.length).toBe(66);
  const afterRestart = createSource(filteredOptions);
  await refresh(afterRestart, q.context({ allowNetwork: false, stored: q.stored() }));
  expect(runSync(afterRestart.models).map((model) => model.id)).toStrictEqual(recommendedIDs);
  isRecommendedOnly = false;
  runSync(afterRestart.rebuild);
  expect(runSync(afterRestart.models).map((model) => model.id)).toStrictEqual(runSync(source.models).map((model) => model.id));
  // The sidekick child Pi uses every exact UID, but the shared stored list keeps only the default list. A lead restoring it gets no sidekick-only entries.
  const childOptions = { ...options, fusion: false as const, listsAllExactModels: true }, r = publications();
  const child = createSource(childOptions);
  await refresh(child, r.context());
  expect(runSync(child.models).length).toBe(326);
  const shared = r.stored()!.models.map((model) => model.id);
  expect([shared.length, shared.includes("swe-2-high"), shared.includes("swe-2")]).toStrictEqual([65, false, true]);
  const lead = createSource(options);
  await refresh(lead, r.context({ allowNetwork: false, stored: r.stored() }));
  expect(runSync(lead.models).map((model) => model.id)).toStrictEqual(runSync(source.models).map((model) => model.id));
  const childAgain = createSource(childOptions);
  await refresh(childAgain, r.context({ allowNetwork: false, stored: r.stored() }));
  expect(runSync(childAgain.models).length).toBe(326);
});

test("after an account or endpoint change or logout, the old list is not exposed as authorized models", async () => {
  const source = createSource({ credentialFromHost, fetchCatalog: () => parseModelCatalog(raw) });
  const p = publications(); await refresh(source, p.context());
  const oldModels = runSync(source.models), saved = p.stored()!;
  const other = { ...hostCredential, access: "different-fake-account" } as HostCredential;
  expect(runSync(source.filter(oldModels, other))).toStrictEqual([]);
  await refresh(source, p.context({ credential: other, stored: saved, allowNetwork: false }));
  expect(runSync(source.models)).toStrictEqual([]);
  await refresh(source, p.context({ credential: hostCredential, baseUrl: "https://other.invalid", stored: saved, allowNetwork: false }));
  expect(runSync(source.models)).toStrictEqual([]);
  // Removing the override does not implicitly reuse the previous one.
  await refresh(source, p.context({ credential: hostCredential, baseUrl: undefined, stored: saved, allowNetwork: false }));
  expect(runSync(source.models).length).toBe(66);
  await refresh(source, p.context({ credential: undefined, allowNetwork: false }));
  expect(runSync(source.models)).toStrictEqual([]);
  expect(runSync(source.filter(oldModels, undefined))).toStrictEqual([]);
});

test("a new session of the same verified account reuses the stored catalog under the new session; an unverified or different account does not", async () => {
  const account = "a".repeat(64), verified = new Map<string, string>([[credential.sessionToken, account]]);
  let calls = 0;
  const options = { credentialFromHost, accountOf: (value: { sessionToken: string }) => verified.get(value.sessionToken),
    fetchCatalog: () => Effect.suspend(() => { calls++; return parseModelCatalog(raw); }) };
  const p = publications();
  await refresh(createSource(options), p.context());
  const saved = p.stored()!;
  const accounts = (entry: ModelsStoreEntry) => new Set(entry.models.map((model) => (model as DevinModel).devin.account));
  expect(accounts(saved)).toStrictEqual(new Set([account]));
  const renewed = { ...hostCredential, access: "renewed-fake-session" } as HostCredential;
  // Without a verified account for the new session, or for another account, the stored list is not shown.
  for (const known of [undefined, "b".repeat(64)]) {
    if (known) verified.set("renewed-fake-session", known);
    const source = createSource(options);
    await refresh(source, p.context({ credential: renewed, stored: saved, allowNetwork: false }));
    expect(runSync(source.models)).toStrictEqual([]);
    expect(p.stored()).toStrictEqual(saved);
  }
  // The same account gets the list at once without network, scoped to the new session, and stored under it.
  verified.set("renewed-fake-session", account);
  const reused = createSource(options);
  await refresh(reused, p.context({ credential: renewed, stored: saved, allowNetwork: false }));
  expect(runSync(reused.models).length).toBe(66);
  expect(runSync(reused.filter(runSync(reused.models), renewed)).length).toBe(66);
  expect(runSync(reused.filter(runSync(reused.models), hostCredential))).toStrictEqual([]);
  expect(new Set(p.stored()!.models.map((model) => (model as DevinModel).devin.scope))).toStrictEqual(new Set([runSync(reused.models)[0].devin.scope]));
  expect(calls).toBe(1);
  // After a restart the new session restores its stored list before its account is checked again, and a refetch keeps the account.
  verified.delete("renewed-fake-session");
  const restarted = createSource(options);
  await refresh(restarted, p.context({ credential: renewed, stored: p.stored(), allowNetwork: false }));
  expect(runSync(restarted.models).length).toBe(66);
  await refresh(restarted, p.context({ credential: renewed, stored: p.stored(), force: true }));
  expect(calls).toBe(2);
  expect(accounts(p.stored()!)).toStrictEqual(new Set([account]));
});

test("forced and expired refreshes, last-good on failure, and new disabled permissions apply", async () => {
  let now = 1000, calls = 0, failure = false, disabled = false;
  const source = createSource({ credentialFromHost, now: () => now, fetchCatalog: () => Effect.suspend(() => {
    calls++; if (failure) return failWith("temporary offline");
    const value = structuredClone(raw);
    if (disabled) (value.clientModelConfigs as JsonObject[]).find((config) => config.modelUid === "swe-2-medium")!.disabled = true;
    return parseModelCatalog(value);
  }) });
  const p = publications(); await refresh(source, p.context());
  const before = runSync(source.models);
  await refresh(source, p.context()); expect(calls).toBe(1);
  failure = true;
  await expect(refresh(source, p.context({ force: true }))).rejects.toThrow(/temporary offline/);
  expect(runSync(source.models)).toBe(before);
  failure = false; disabled = true; now += 300_001;
  await refresh(source, p.context());
  expect(calls).toBe(3);
  expect(() => runSync(source.resolve("swe-2-medium", "medium", credential))).toThrow();
  expect(runSync(source.models).some((model) => model.id === "swe-2-medium")).toBe(false);
});

test("late responses after cancel and rejected publishes do not change the last good list", async () => {
  let resolve!: (value: ReturnType<typeof parseModelCatalog>) => void, isDeferred = false;
  const source = createSource({ credentialFromHost, fetchCatalog: () => isDeferred
    ? Effect.flatten(fromAsync(() => new Promise<Effect.Effect<ModelCatalog, never>>((done) => { resolve = done as typeof resolve; })))
    : parseModelCatalog(raw) });
  const p = publications(); await refresh(source, p.context());
  const before = runSync(source.models), publicationsBefore = p.history.length;
  isDeferred = true;
  const controller = new AbortController();
  const pending = refresh(source, p.context({ force: true, signal: controller.signal }));
  controller.abort();
  await expect(pending).rejects.toThrow(expect.objectContaining({ name: "AbortError" })); // Returns even though fetchCatalog has not finished yet.
  resolve(parseModelCatalog({ clientModelConfigs: [] }));
  await Promise.resolve();
  expect(runSync(source.models)).toBe(before); expect(p.history.length).toBe(publicationsBefore);
  isDeferred = false;
  await refresh(source, p.context({ force: true, publish: async () => false }));
  expect(runSync(source.models)).toBe(before);
});

test("public Models publish/persist and cache restore keep the extension metadata", async () => {
  const credentials = new InMemoryCredentialStore(), store = new InMemoryModelsStore();
  await credentials.modify("devin", async () => hostCredential);
  let calls = 0;
  const options = { credentialFromHost, fetchCatalog: () => Effect.suspend(() => { calls++; return parseModelCatalog(raw); }) };
  const createProvider = (source: ModelCatalogShape): Provider<typeof DEVIN_API> => ({
    id: "devin", name: "Devin", getModels: () => runSync(source.models), filterModels: (models, credential) => runSync(source.filter(models, credential)),
    refreshModels: (context) => refresh(source, context),
    auth: { oauth: { name: "fake", login: async () => { throw new Error("No login"); }, refresh: async (value) => value, toAuth: async (value) => ({ apiKey: value.access }) } },
    stream: () => { throw new Error("No inference"); }, streamSimple: () => { throw new Error("No inference"); },
  });
  const models = createModels({ credentials, modelsStore: store, authContext: { env: async () => undefined, fileExists: async () => false } });
  const first = createSource(options); models.setProvider(createProvider(first));
  expect((await models.refresh({ allowNetwork: true })).errors.size).toBe(0);
  expect(models.getModels("devin").length).toBe(66); expect(calls).toBe(1);
  const second = createSource(options); models.setProvider(createProvider(second));
  expect((await models.refresh({ allowNetwork: false })).errors.size).toBe(0);
  expect(runSync(second.models)).toStrictEqual(runSync(first.models));
  expect((await models.getAvailable("devin")).length).toBe(66);
  await models.logout("devin");
  await models.refresh({ allowNetwork: false });
  expect(models.getModels("devin")).toStrictEqual([]);
  expect(calls).toBe(1);
});
