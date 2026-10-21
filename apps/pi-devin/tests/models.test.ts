import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
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
    expect(config, `${uid} is missing from the fixture.`).toBeTruthy(); if (!config) throw new Error("unreachable");
    return structuredClone(config);
  });
}

test("classifies all 265 fixture catalog entries, lists 65 groups and a single Fusion with readable names, and picks exact UIDs through group levels", () => {
  expect(projection.variants.length).toBe(265);
  expect(projection.groups.length).toBe(69);
  expect(projection.groups.filter((group) => group.canPublish).length).toBe(65);
  expect(projection.unsupported.map((entry) => entry.uid).sort()).toStrictEqual(["kimi-k2-6", "kimi-k2-7", "swe-1-6", "swe-1-6-fast"]);
  // Every exact UID maps to a level of a published group, so the lead list keeps only the 65 groups and Fusion.
  expect(piModels.length).toBe(66);
  expect(new Set(piModels.map((model) => model.id)).size).toBe(66);
  // Pi `/model` shows IDs, so IDs are human-readable slugs. They never reveal the internal key (`family:`), `uid:` or base64.
  expect(piModels.some((model) => model.id.includes(":") || isExactID(model.id))).toBe(false);
  for (const id of ["swe-2", "swe-2-fast-mode", "gpt-5.6-sol", "claude-opus-4.8", "claude-opus-4.8-fast-mode", "claude-opus-4.6-1m-context", FUSION_MODEL_ID]) {
    expect(piModels.some((model) => model.id === id), id).toBeTruthy();
  }
  expect(FUSION_MODEL_ID).toBe("fusion");
  // Names add only dimensions whose values differ within a family, and never defaults (0), internal notation or cost wording.
  expect(new Set(piModels.map((model) => model.name)).size).toBe(66);
  expect(piModels.some((model) => /[[\]=]|cost unknown/i.test(model.name))).toBe(false);
  const named = (pattern: RegExp) => piModels.filter((model) => pattern.test(model.id)).map((model) => model.name).sort();
  expect(named(/^swe-2(-fast-mode)?$/)).toStrictEqual(["SWE-2", "SWE-2 · Fast Mode"]);
  expect(named(/^gpt-5\.6-sol(-fast-mode)?$/)).toStrictEqual(["GPT-5.6 Sol", "GPT-5.6 Sol · Fast Mode"]);
  // The sidekick child Pi runs on exact UIDs, so it has every exact UID.
  const childModels = modelsFromProjection(projection, credential, { fusion: false, listsAllExactModels: true });
  expect([childModels.length, childModels.filter((model) => isExactID(model.id)).length, childModels.some((model) => isFusionModelID(model.id))]).toStrictEqual([326, 261, false]);
  expect(new Set(childModels.map((model) => model.id)).size).toBe(326);
  const fusions = piModels.filter((model) => isFusionModelID(model.id));
  expect(fusions.map((model) => model.id)).toStrictEqual([FUSION_MODEL_ID]);
  // Without a saved value, the default sidekick (SWE-2 Medium) is paired with its own group as the lead.
  const fusionFor = (models: typeof piModels) => models.find((model) => model.id === FUSION_MODEL_ID);
  const assertPair = (fusion: (typeof piModels)[number] | undefined, leadID: string, sidekickID: string, sidekickName: string) => {
    expect(fusion).toBeTruthy(); if (!fusion) throw new Error("unreachable");
    const lead = piModels.find((model) => model.id === leadID)!;
    expect(fusion.devin.fusion).toStrictEqual({ leadID, sidekickID });
    expect(fusion.thinkingLevelMap).toStrictEqual(lead.thinkingLevelMap);
    expect([fusion.contextWindow, fusion.maxTokens, fusion.input]).toStrictEqual([lead.contextWindow, lead.maxTokens, lead.input]);
    expect(fusion.name).toBe(`Devin Fusion · ${lead.name} + ${sidekickName}`);
  };
  const swe2 = piModels.find((model) => model.id === "swe-2")!;
  expect(swe2.thinkingLevelMap!.medium).toBe("swe-2-medium");
  assertPair(fusionFor(piModels), swe2.id, "swe-2-medium", "SWE-2 Medium");
  expect(piModels.filter((model) => !isFusionModelID(model.id) && model.devin.fusion).length).toBe(0);
  // Recommended filter: models that map a variant the catalog marks isRecommended stay listed as groups; the Fusion entry stays.
  const recommendedUIDs = new Set(catalog.models.filter((model) => model.isRecommended).map((model) => model.id));
  const mapsRecommended = (model: (typeof piModels)[number]) => Object.values(model.thinkingLevelMap ?? {}).some((uid) => typeof uid === "string" && recommendedUIDs.has(uid));
  const filtered = modelsFromProjection(projection, credential, { recommendedOnly: true });
  expect(recommendedUIDs.size > 0).toBeTruthy();
  expect(filtered.map((model) => model.id)).toStrictEqual(piModels.filter((model) => isFusionModelID(model.id) || mapsRecommended(model)).map((model) => model.id));
  expect(filtered.length < piModels.length).toBeTruthy();
  expect(filtered.every((model) => model.devin.recommended === true || isFusionModelID(model.id))).toBe(true);
  expect(filtered.some((model) => isExactID(model.id))).toBe(false);
  // Every recommended UID stays reachable through `/thinking` of a listed group, with the default list's names and level mappings.
  for (const uid of recommendedUIDs) expect(filtered.some((model) => Object.values(model.thinkingLevelMap ?? {}).includes(uid)), uid).toBeTruthy();
  for (const model of filtered) {
    const listed = piModels.find((entry) => entry.id === model.id)!;
    expect([model.name, model.thinkingLevelMap], model.id).toStrictEqual([listed.name, listed.thinkingLevelMap]);
  }
  // In the default projection, groups with a recommended variant are flagged and IDs and counts stay the same.
  expect(piModels.filter((model) => model.devin.recommended === true).length).toBe(13);
  expect(piModels.find((model) => model.id === swe2.id)!.devin.recommended).toBe(true);
  // With a catalog that has no recommended flags, the filter falls back to the default group list.
  const unmarked = parseModelCatalog({ clientModelConfigs: (raw.clientModelConfigs as JsonObject[]).map((config) => ({ ...config, isRecommended: false })) });
  const fallback = modelsFromProjection(projectModelVariants(unmarked), credential, { recommendedOnly: true });
  expect([fallback.length, fallback.some((model) => model.devin.recommended)]).toStrictEqual([66, false]);
  // Candidates are published groups and exact UIDs that support tool calls. The saved pair is reflected in the name, thinking levels and lead.
  const choices = fusionChoices(projection);
  expect(choices.leads.length).toBe(65);
  expect(choices.sidekicks.length > 0 && choices.sidekicks.every((item) => isExactID(item.id) && !item.id.includes(":"))).toBeTruthy();
  // Candidates carry the recommended flag too, so the picker can show a badge.
  expect(choices.sidekicks.find((item) => item.id === "swe-2-high")?.recommended).toBe(true);
  expect(choices.sidekicks.find((item) => item.id === "swe-2-medium")?.recommended).toBe(undefined);
  expect(choices.leads.filter((item) => item.recommended).length).toBe(13);
  expect(choices.sidekicks.find((item) => item.id === "swe-2-medium")?.level).toBe("medium");
  const sol = piModels.find((model) => model.id === "gpt-5.6-sol")!;
  expect(sol.thinkingLevelMap!.medium).toBe("gpt-5-6-sol-medium");
  assertPair(fusionFor(modelsFromProjection(projection, credential, { fusion: { leadID: sol.id, sidekickID: "swe-2-high" } })), sol.id, "swe-2-high", "SWE-2 High");
  // A choice saved in the legacy format (`family:…`, `uid:…`) is read as the same model's new ID.
  const legacySol = projection.groups.find((group) => ids.groups.get(group.id) === sol.id)!.id;
  expect(legacySol).toMatch(/^family:gpt-5\.6-sol:/);
  assertPair(fusionFor(modelsFromProjection(projection, credential, { fusion: { leadID: legacySol, sidekickID: "uid:swe-2-high" } })), sol.id, "swe-2-high", "SWE-2 High");
  // Values missing from the list fall back to the default per item.
  assertPair(fusionFor(modelsFromProjection(projection, credential, { fusion: { leadID: "missing-lead", sidekickID: "swe-2-high" } })), swe2.id, "swe-2-high", "SWE-2 High");
  assertPair(fusionFor(modelsFromProjection(projection, credential, { fusion: { leadID: sol.id, sidekickID: "missing" } })), sol.id, "swe-2-medium", "SWE-2 Medium");
  // A sidekick process (false) and a catalog without the default sidekick create no Fusion entry.
  expect(fusionFor(modelsFromProjection(projection, credential, { fusion: false }))).toBe(undefined);
  const withoutSidekick = parseModelCatalog({ clientModelConfigs: (raw.clientModelConfigs as JsonObject[]).filter((config) => config.modelUid !== "swe-2-medium") });
  const plain = modelsFromProjection(projectModelVariants(withoutSidekick), credential);
  expect(plain.some((model) => isFusionModelID(model.id))).toBe(false);
  for (const model of piModels) {
    const levels = getSupportedThinkingLevels(model);
    expect(levels).toStrictEqual(EFFECTIVE_THINKING_LEVELS.filter((level) => model.thinkingLevelMap![level] !== null));
    expect(model.cost).toStrictEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(model.devin.costsUnknown).toBe(true);
  }
});

test("each exact UID and group/level round-trips to the final protobuf request UID and the 5000 output limit", () => {
  let checked = 0;
  const childModels = modelsFromProjection(projection, credential, { fusion: false, listsAllExactModels: true });
  for (const variant of projection.variants) {
    if (variant.level === undefined || variant.unsupported) continue;
    const selected = resolveBackendSelection(projection, modelIDForUID(variant.model.id), variant.level);
    expect(selected.uid).toBe(variant.model.id);
    // A variant's public ID is its catalog UID.
    expect(ids.variants.get(variant.model.id)).toBe(variant.model.id);
    const model = childModels.find((model) => model.id === variant.model.id)!;
    expect(model.contextWindow).toBe(variant.model.contextWindow);
    expect(model.maxTokens).toBe(variant.model.maxOutputTokens);
    expect(model.input.includes("image")).toBe(variant.model.supportsImages);
    const group = projection.groups.find((group) => group.variants.includes(variant))!;
    expect(resolveBackendSelection(projection, group.id, variant.level).uid).toBe(variant.model.id);
    const request = chatRequest({ metadata: { apiKey: "fake-only" }, model: selected.uid,
      messages: [{ messageId: "user", source: "CHAT_MESSAGE_SOURCE_USER", prompt: "offline" }],
      systemPrompt: "offline", maxTokens: 5000, cascadeId: "cascade", trajectoryId: "trajectory", includeContext: false,
    });
    const decoded = chatRequestCodec.decode(chatRequestCodec.encode(request));
    expect(decoded.chatModelUid).toBe(variant.model.id);
    expect((decoded.configuration as JsonObject).maxTokens).toBe("5000");
    checked++;
  }
  expect(checked).toBe(261);
});

test("SWE-2 supported levels, the Lightning dimension, and Pi clamping vs explicit choice", () => {
  const groups = projection.groups.filter((group) => group.family === "swe-2");
  expect(groups.length).toBe(2);
  const selectedUIDs = new Set<string>();
  for (const group of groups) {
    const model = piModels.find((model) => model.id === ids.groups.get(group.id))!;
    expect(getSupportedThinkingLevels(model)).toStrictEqual(["medium", "high", "max"]);
    expect(() => resolveBackendSelection(projection, group.id, "low")).toThrow(/unavailable/);
    expect(clampThinkingLevel(model, "off")).toBe("medium");
    expect(clampThinkingLevel(model, "xhigh")).toBe("max");
    selectedUIDs.add(resolveBackendSelection(projection, group.id, clampThinkingLevel(model, "off")).uid);
    expect(resolveBackendSelection(projection, group.id, "max").uid).toBe(group.mappings.max);
  }
  expect(selectedUIDs.size).toBe(2);
});

test("GPT-5.4 and Claude toggles expose only declared levels, and unverified models get no synthetic high", () => {
  const gptGroups = projection.groups.filter((group) => group.family === "gpt-5.4");
  expect(gptGroups.length > 0).toBeTruthy();
  for (const group of gptGroups) {
    expect(getSupportedThinkingLevels(piModels.find((model) => model.id === ids.groups.get(group.id))!)).toStrictEqual(["off", "low", "medium", "high", "xhigh"]);
  }
  const toggles = projection.groups.filter((group) => group.family === "claude-opus-4.6");
  expect(toggles.length > 0).toBeTruthy();
  for (const group of toggles) {
    expect(getSupportedThinkingLevels(piModels.find((model) => model.id === ids.groups.get(group.id))!)).toStrictEqual(["off", "high"]);
  }
  for (const { uid } of projection.unsupported) {
    expect(piModels.some((model) => model.id === uid)).toBe(false);
    expect(() => resolveBackendSelection(projection, modelIDForUID(uid), "high")).toThrow(/does not support/);
  }
});

test("same-level collisions and per-variant limit differences hide the group but keep the exact UIDs", () => {
  const duplicate = configsFor("swe-2-medium")[0];
  duplicate.modelUid = "synthetic-other-uid";
  (duplicate.modelInfo as JsonObject).modelUid = duplicate.modelUid;
  (duplicate.modelInfo as JsonObject).aliases = ["swe-2-medium"];
  const colliding = projectModelVariants(parseModelCatalog({ clientModelConfigs: [...configsFor("swe-2-medium"), duplicate] }));
  expect(colliding.groups[0].canPublish).toBe(false);
  expect(() => resolveBackendSelection(colliding, colliding.groups[0].id, "medium")).toThrow();
  expect(resolveBackendSelection(colliding, modelIDForUID("swe-2-medium"), "medium").uid).toBe("swe-2-medium");
  expect(resolveBackendSelection(colliding, modelIDForUID("synthetic-other-uid"), "medium").uid).toBe("synthetic-other-uid");
  expect(getModelByUID(colliding.variants.map((variant) => variant.model), "swe-2-medium").id).toBe("swe-2-medium");
  const changed = configsFor("swe-2-medium", "swe-2-high");
  (changed[1].modelInfo as JsonObject).maxOutputTokens = 64;
  const differentLimits = projectModelVariants(parseModelCatalog({ clientModelConfigs: changed }));
  expect(differentLimits.groups[0].canPublish).toBe(false);
  const exact = modelsFromProjection(differentLimits, credential);
  expect(exact.length).toBe(2);
  expect(exact.find((model) => model.id === "swe-2-high")!.maxTokens).toBe(64);
});

test("disabled and duplicate UIDs are not bypassed and the catalog input is not mutated", () => {
  const changed = configsFor("swe-2-medium", "swe-2-high"); changed[0].disabled = true;
  const before = JSON.stringify(changed);
  const result = projectModelVariants(parseModelCatalog({ clientModelConfigs: changed }));
  expect(result.groups[0].mappings.medium).toBe(undefined);
  expect(() => resolveBackendSelection(result, result.groups[0].id, "medium")).toThrow();
  expect(() => resolveBackendSelection(result, modelIDForUID("swe-2-medium"), "medium")).toThrow();
  expect(JSON.stringify(changed)).toBe(before);
  expect(() => projectModelVariants(parseModelCatalog({ clientModelConfigs: [changed[1], changed[1]] }))).toThrow(/Duplicate model UID/);
});
