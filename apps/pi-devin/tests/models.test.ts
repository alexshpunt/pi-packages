import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { parseModelCatalog } from "../src/core/models/catalog.ts";
import { EFFECTIVE_THINKING_LEVELS, modelIDForUID, projectModelVariants, resolveBackendSelection } from "../src/core/models/variants.ts";
import { FUSION_MODEL_ID, fusionChoices, isFusionModelID, modelsFromProjection, publicModelIDs } from "../src/pi/models.ts";
import { chatRequest } from "../src/core/inference/chat.ts";
import { chatRequestCodec } from "../src/core/protocol/protobuf.ts";
import { getModelByUID } from "../src/core/models/select.ts";
import type { JsonObject } from "../src/core/types.ts";
import { credential } from "./helpers.ts";

const raw = JSON.parse(await readFile(new URL("./fixtures/model-catalog.json", import.meta.url), "utf8")) as JsonObject;
const catalog = parseModelCatalog(raw);
const projection = projectModelVariants(catalog);
const piModels = modelsFromProjection(projection, credential);
const ids = publicModelIDs(projection);
const isExactID = (id: string) => { const target = ids.targets.get(id); return target !== undefined && "variant" in target; };

function configsFor(...uids: string[]): JsonObject[] {
  return uids.map((uid) => {
    const config = (raw.clientModelConfigs as JsonObject[]).find((entry) => entry.modelUid === uid);
    assert.ok(config, `${uid} is missing from the fixture.`);
    return structuredClone(config);
  });
}

test("classifies all 265 fixture catalog entries, lists 65 groups and a single Fusion with readable names, and picks exact UIDs through group levels", () => {
  assert.equal(projection.variants.length, 265);
  assert.equal(projection.groups.length, 69);
  assert.equal(projection.groups.filter((group) => group.canPublish).length, 65);
  assert.deepEqual(projection.unsupported.map((entry) => entry.uid).sort(), ["kimi-k2-6", "kimi-k2-7", "swe-1-6", "swe-1-6-fast"]);
  // Every exact UID maps to a level of a published group, so the lead list keeps only the 65 groups and Fusion.
  assert.equal(piModels.length, 66);
  assert.equal(new Set(piModels.map((model) => model.id)).size, 66);
  // Pi `/model` shows IDs, so IDs are human-readable slugs. They never reveal the internal key (`family:`), `uid:` or base64.
  assert.equal(piModels.some((model) => model.id.includes(":") || isExactID(model.id)), false);
  for (const id of ["swe-2", "swe-2-fast-mode", "gpt-5.6-sol", "claude-opus-4.8", "claude-opus-4.8-fast-mode", "claude-opus-4.6-1m-context", FUSION_MODEL_ID]) {
    assert.ok(piModels.some((model) => model.id === id), id);
  }
  assert.equal(FUSION_MODEL_ID, "fusion");
  // Names add only dimensions whose values differ within a family, and never defaults (0), internal notation or cost wording.
  assert.equal(new Set(piModels.map((model) => model.name)).size, 66);
  assert.equal(piModels.some((model) => /[[\]=]|cost unknown/i.test(model.name)), false);
  const named = (pattern: RegExp) => piModels.filter((model) => pattern.test(model.id)).map((model) => model.name).sort();
  assert.deepEqual(named(/^swe-2(-fast-mode)?$/), ["SWE-2", "SWE-2 · Fast Mode"]);
  assert.deepEqual(named(/^gpt-5\.6-sol(-fast-mode)?$/), ["GPT-5.6 Sol", "GPT-5.6 Sol · Fast Mode"]);
  // The sidekick child Pi runs on exact UIDs, so it has every exact UID.
  const childModels = modelsFromProjection(projection, credential, { fusion: false, listsAllExactModels: true });
  assert.deepEqual([childModels.length, childModels.filter((model) => isExactID(model.id)).length, childModels.some((model) => isFusionModelID(model.id))], [326, 261, false]);
  assert.equal(new Set(childModels.map((model) => model.id)).size, 326);
  const fusions = piModels.filter((model) => isFusionModelID(model.id));
  assert.deepEqual(fusions.map((model) => model.id), [FUSION_MODEL_ID]);
  // Without a saved value, the default sidekick (SWE-2 Medium) is paired with its own group as the lead.
  const fusionFor = (models: typeof piModels) => models.find((model) => model.id === FUSION_MODEL_ID);
  const assertPair = (fusion: (typeof piModels)[number] | undefined, leadID: string, sidekickID: string, sidekickName: string) => {
    assert.ok(fusion);
    const lead = piModels.find((model) => model.id === leadID)!;
    assert.deepEqual(fusion.devin.fusion, { leadID, sidekickID });
    assert.deepEqual(fusion.thinkingLevelMap, lead.thinkingLevelMap);
    assert.deepEqual([fusion.contextWindow, fusion.maxTokens, fusion.input], [lead.contextWindow, lead.maxTokens, lead.input]);
    assert.equal(fusion.name, `Devin Fusion · ${lead.name} + ${sidekickName}`);
  };
  const swe2 = piModels.find((model) => model.id === "swe-2")!;
  assert.equal(swe2.thinkingLevelMap!.medium, "swe-2-medium");
  assertPair(fusionFor(piModels), swe2.id, "swe-2-medium", "SWE-2 Medium");
  assert.equal(piModels.filter((model) => !isFusionModelID(model.id) && model.devin.fusion).length, 0);
  // Recommended filter: models that map a variant the catalog marks isRecommended stay listed as groups; the Fusion entry stays.
  const recommendedUIDs = new Set(catalog.models.filter((model) => model.isRecommended).map((model) => model.id));
  const mapsRecommended = (model: (typeof piModels)[number]) => Object.values(model.thinkingLevelMap ?? {}).some((uid) => typeof uid === "string" && recommendedUIDs.has(uid));
  const filtered = modelsFromProjection(projection, credential, { recommendedOnly: true });
  assert.ok(recommendedUIDs.size > 0);
  assert.deepEqual(filtered.map((model) => model.id), piModels.filter((model) => isFusionModelID(model.id) || mapsRecommended(model)).map((model) => model.id));
  assert.ok(filtered.length < piModels.length);
  assert.equal(filtered.every((model) => model.devin.recommended === true || isFusionModelID(model.id)), true);
  assert.equal(filtered.some((model) => isExactID(model.id)), false);
  // Every recommended UID stays reachable through `/thinking` of a listed group, with the default list's names and level mappings.
  for (const uid of recommendedUIDs) assert.ok(filtered.some((model) => Object.values(model.thinkingLevelMap ?? {}).includes(uid)), uid);
  for (const model of filtered) {
    const listed = piModels.find((entry) => entry.id === model.id)!;
    assert.deepEqual([model.name, model.thinkingLevelMap], [listed.name, listed.thinkingLevelMap], model.id);
  }
  // In the default projection, groups with a recommended variant are flagged and IDs and counts stay the same.
  assert.equal(piModels.filter((model) => model.devin.recommended === true).length, 13);
  assert.equal(piModels.find((model) => model.id === swe2.id)!.devin.recommended, true);
  // With a catalog that has no recommended flags, the filter falls back to the default group list.
  const unmarked = parseModelCatalog({ clientModelConfigs: (raw.clientModelConfigs as JsonObject[]).map((config) => ({ ...config, isRecommended: false })) });
  const fallback = modelsFromProjection(projectModelVariants(unmarked), credential, { recommendedOnly: true });
  assert.deepEqual([fallback.length, fallback.some((model) => model.devin.recommended)], [66, false]);
  // Candidates are published groups and exact UIDs that support tool calls. The saved pair is reflected in the name, thinking levels and lead.
  const choices = fusionChoices(projection);
  assert.equal(choices.leads.length, 65);
  assert.ok(choices.sidekicks.length > 0 && choices.sidekicks.every((item) => isExactID(item.id) && !item.id.includes(":")));
  // Candidates carry the recommended flag too, so the picker can show a badge.
  assert.equal(choices.sidekicks.find((item) => item.id === "swe-2-high")?.recommended, true);
  assert.equal(choices.sidekicks.find((item) => item.id === "swe-2-medium")?.recommended, undefined);
  assert.equal(choices.leads.filter((item) => item.recommended).length, 13);
  assert.equal(choices.sidekicks.find((item) => item.id === "swe-2-medium")?.level, "medium");
  const sol = piModels.find((model) => model.id === "gpt-5.6-sol")!;
  assert.equal(sol.thinkingLevelMap!.medium, "gpt-5-6-sol-medium");
  assertPair(fusionFor(modelsFromProjection(projection, credential, { fusion: { leadID: sol.id, sidekickID: "swe-2-high" } })), sol.id, "swe-2-high", "SWE-2 High");
  // A choice saved in the legacy format (`family:…`, `uid:…`) is read as the same model's new ID.
  const legacySol = projection.groups.find((group) => ids.groups.get(group.id) === sol.id)!.id;
  assert.match(legacySol, /^family:gpt-5\.6-sol:/);
  assertPair(fusionFor(modelsFromProjection(projection, credential, { fusion: { leadID: legacySol, sidekickID: "uid:swe-2-high" } })), sol.id, "swe-2-high", "SWE-2 High");
  // Values missing from the list fall back to the default per item.
  assertPair(fusionFor(modelsFromProjection(projection, credential, { fusion: { leadID: "missing-lead", sidekickID: "swe-2-high" } })), swe2.id, "swe-2-high", "SWE-2 High");
  assertPair(fusionFor(modelsFromProjection(projection, credential, { fusion: { leadID: sol.id, sidekickID: "missing" } })), sol.id, "swe-2-medium", "SWE-2 Medium");
  // A sidekick process (false) and a catalog without the default sidekick create no Fusion entry.
  assert.equal(fusionFor(modelsFromProjection(projection, credential, { fusion: false })), undefined);
  const withoutSidekick = parseModelCatalog({ clientModelConfigs: (raw.clientModelConfigs as JsonObject[]).filter((config) => config.modelUid !== "swe-2-medium") });
  const plain = modelsFromProjection(projectModelVariants(withoutSidekick), credential);
  assert.equal(plain.some((model) => isFusionModelID(model.id)), false);
  for (const model of piModels) {
    const levels = getSupportedThinkingLevels(model);
    assert.deepEqual(levels, EFFECTIVE_THINKING_LEVELS.filter((level) => model.thinkingLevelMap![level] !== null));
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(model.devin.costsUnknown, true);
  }
});

test("each exact UID and group/level round-trips to the final protobuf request UID and the 5000 output limit", () => {
  let checked = 0;
  const childModels = modelsFromProjection(projection, credential, { fusion: false, listsAllExactModels: true });
  for (const variant of projection.variants) {
    if (variant.level === undefined || variant.unsupported) continue;
    const selected = resolveBackendSelection(projection, modelIDForUID(variant.model.id), variant.level);
    assert.equal(selected.uid, variant.model.id);
    // A variant's public ID is its catalog UID.
    assert.equal(ids.variants.get(variant.model.id), variant.model.id);
    const model = childModels.find((model) => model.id === variant.model.id)!;
    assert.equal(model.contextWindow, variant.model.contextWindow);
    assert.equal(model.maxTokens, variant.model.maxOutputTokens);
    assert.equal(model.input.includes("image"), variant.model.supportsImages);
    const group = projection.groups.find((group) => group.variants.includes(variant))!;
    assert.equal(resolveBackendSelection(projection, group.id, variant.level).uid, variant.model.id);
    const request = chatRequest({ metadata: { apiKey: "fake-only" }, model: selected.uid,
      messages: [{ messageId: "user", source: "CHAT_MESSAGE_SOURCE_USER", prompt: "offline" }],
      systemPrompt: "offline", maxTokens: 5000, cascadeId: "cascade", trajectoryId: "trajectory", includeContext: false,
    });
    const decoded = chatRequestCodec.decode(chatRequestCodec.encode(request));
    assert.equal(decoded.chatModelUid, variant.model.id);
    assert.equal((decoded.configuration as JsonObject).maxTokens, "5000");
    checked++;
  }
  assert.equal(checked, 261);
});

test("SWE-2 supported levels, the Lightning dimension, and Pi clamping vs explicit choice", () => {
  const groups = projection.groups.filter((group) => group.family === "swe-2");
  assert.equal(groups.length, 2);
  const selectedUIDs = new Set<string>();
  for (const group of groups) {
    const model = piModels.find((model) => model.id === ids.groups.get(group.id))!;
    assert.deepEqual(getSupportedThinkingLevels(model), ["medium", "high", "max"]);
    assert.throws(() => resolveBackendSelection(projection, group.id, "low"), /unavailable/);
    assert.equal(clampThinkingLevel(model, "off"), "medium");
    assert.equal(clampThinkingLevel(model, "xhigh"), "max");
    selectedUIDs.add(resolveBackendSelection(projection, group.id, clampThinkingLevel(model, "off")).uid);
    assert.equal(resolveBackendSelection(projection, group.id, "max").uid, group.mappings.max);
  }
  assert.equal(selectedUIDs.size, 2);
});

test("GPT-5.4 and Claude toggles expose only declared levels, and unverified models get no synthetic high", () => {
  const gptGroups = projection.groups.filter((group) => group.family === "gpt-5.4");
  assert.ok(gptGroups.length > 0);
  for (const group of gptGroups) {
    assert.deepEqual(getSupportedThinkingLevels(piModels.find((model) => model.id === ids.groups.get(group.id))!), ["off", "low", "medium", "high", "xhigh"]);
  }
  const toggles = projection.groups.filter((group) => group.family === "claude-opus-4.6");
  assert.ok(toggles.length > 0);
  for (const group of toggles) {
    assert.deepEqual(getSupportedThinkingLevels(piModels.find((model) => model.id === ids.groups.get(group.id))!), ["off", "high"]);
  }
  for (const { uid } of projection.unsupported) {
    assert.equal(piModels.some((model) => model.id === uid), false);
    assert.throws(() => resolveBackendSelection(projection, modelIDForUID(uid), "high"), /does not support/);
  }
});

test("same-level collisions and per-variant limit differences hide the group but keep the exact UIDs", () => {
  const duplicate = configsFor("swe-2-medium")[0];
  duplicate.modelUid = "synthetic-other-uid";
  (duplicate.modelInfo as JsonObject).modelUid = duplicate.modelUid;
  (duplicate.modelInfo as JsonObject).aliases = ["swe-2-medium"];
  const colliding = projectModelVariants(parseModelCatalog({ clientModelConfigs: [...configsFor("swe-2-medium"), duplicate] }));
  assert.equal(colliding.groups[0].canPublish, false);
  assert.throws(() => resolveBackendSelection(colliding, colliding.groups[0].id, "medium"));
  assert.equal(resolveBackendSelection(colliding, modelIDForUID("swe-2-medium"), "medium").uid, "swe-2-medium");
  assert.equal(resolveBackendSelection(colliding, modelIDForUID("synthetic-other-uid"), "medium").uid, "synthetic-other-uid");
  assert.equal(getModelByUID(colliding.variants.map((variant) => variant.model), "swe-2-medium").id, "swe-2-medium");
  const changed = configsFor("swe-2-medium", "swe-2-high");
  (changed[1].modelInfo as JsonObject).maxOutputTokens = 64;
  const differentLimits = projectModelVariants(parseModelCatalog({ clientModelConfigs: changed }));
  assert.equal(differentLimits.groups[0].canPublish, false);
  const exact = modelsFromProjection(differentLimits, credential);
  assert.equal(exact.length, 2);
  assert.equal(exact.find((model) => model.id === "swe-2-high")!.maxTokens, 64);
});

test("disabled and duplicate UIDs are not bypassed and the catalog input is not mutated", () => {
  const changed = configsFor("swe-2-medium", "swe-2-high"); changed[0].disabled = true;
  const before = JSON.stringify(changed);
  const result = projectModelVariants(parseModelCatalog({ clientModelConfigs: changed }));
  assert.equal(result.groups[0].mappings.medium, undefined);
  assert.throws(() => resolveBackendSelection(result, result.groups[0].id, "medium"));
  assert.throws(() => resolveBackendSelection(result, modelIDForUID("swe-2-medium"), "medium"));
  assert.equal(JSON.stringify(changed), before);
  assert.throws(() => projectModelVariants(parseModelCatalog({ clientModelConfigs: [changed[1], changed[1]] })), /Duplicate model UID/);
});
