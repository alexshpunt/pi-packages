import { Effect, Predicate } from "effect";
import type { DevinError } from "../errors.ts";
import type { JsonObject, ModelInfo } from "../types.ts";
import { failWith, object, requiredString, tokenCount } from "../validation.ts";
import { parseModelCatalog, type ModelCatalog } from "./catalog.ts";
import { getModelByUID } from "./select.ts";

export const EFFECTIVE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffectiveThinkingLevel = typeof EFFECTIVE_THINKING_LEVELS[number];
export interface ModelDimension { key: string; order: number; name: string }
export interface ModelVariant {
  model: ModelInfo;
  family: string;
  familyName: string;
  dimensions: ModelDimension[];
  level?: EffectiveThinkingLevel;
  unsupported?: string;
  /** Only the model fields the persistent cache needs. Never the whole raw response or auth metadata. */
  config: JsonObject;
}
export interface VariantGroup {
  id: string;
  family: string;
  name: string;
  dimensions: ModelDimension[];
  variants: ModelVariant[];
  mappings: Partial<Record<EffectiveThinkingLevel, string>>;
  canPublish: boolean;
  reason?: string;
}
export interface VariantProjection {
  variants: ModelVariant[];
  groups: VariantGroup[];
  unsupported: { uid: string; reason: string }[];
}
export interface BackendModelSelection { uid: string; model: ModelInfo; level: EffectiveThinkingLevel; variant: ModelVariant }
const strengthNames = new Map<string, EffectiveThinkingLevel>([
  ["None", "off"], ["No Thinking", "off"], ["Minimal", "minimal"], ["Low", "low"],
  ["Medium", "medium"], ["High", "high"], ["XHigh", "xhigh"], ["Max", "max"],
]);
const thinkingDimensions = new Set(["Reasoning Effort", "Effort", "Thinking"]);

export function modelIDForUID(uid: string): string { return "uid:" + encodeURIComponent(uid); }
export function groupModelID(family: string, dimensions: readonly ModelDimension[]): string {
  const key = JSON.stringify(dimensions.map(({ key, order, name }) => [key, order, name]));
  return "family:" + encodeURIComponent(family) + (dimensions.length ? ":" + Buffer.from(key).toString("base64url") : "");
}

function dimensionsOf(config: JsonObject): Effect.Effect<ModelDimension[], DevinError> {
  return Effect.gen(function* () {
    const family = yield* object(config.modelFamilyMetadata ?? {}, "modelFamilyMetadata");
    if (family.entries === undefined) return [];
    if (!Array.isArray(family.entries)) return yield* failWith("Model dimension entries are not an array.");
    const seen = new Set<string>();
    const dimensions: ModelDimension[] = [];
    for (const item of family.entries) {
      const entry = yield* object(item, "model dimension"), value = yield* object(entry.value ?? {}, "dimension value");
      const key = yield* requiredString(entry.key, "dimension key");
      if (seen.has(key)) return yield* failWith(`Duplicate model dimension: ${key}`);
      seen.add(key);
      const order = yield* tokenCount(value.order ?? 0, "dimension order");
      dimensions.push({ key, order, name: Predicate.isString(value.name) ? value.name : "" });
    }
    return dimensions.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}

function classify(model: ModelInfo, dimensions: readonly ModelDimension[]): Pick<ModelVariant, "level" | "unsupported"> {
  if (model.isDisabled) return { unsupported: "disabled" };
  if (model.isRouter) return { unsupported: "router contract not established for Pi" };
  if (model.contextWindow <= 0 || model.maxOutputTokens <= 0) return { unsupported: "missing context/output limit" };
  const thinking = dimensions.find((entry) => entry.key === "Thinking");
  const effort = dimensions.filter((entry) => entry.key === "Reasoning Effort" || entry.key === "Effort");
  if (effort.length > 1) return { unsupported: "ambiguous thinking dimensions" };
  if (thinking?.order === 0 && !model.supportsThinking) return { level: "off" };
  const level = effort[0] && strengthNames.get(effort[0].name);
  if (level) return { level };
  if (!effort.length && !thinking && !model.supportsThinking) return { level: "off" };
  return { unsupported: "thinking strength metadata is unknown" };
}

function sanitizedConfig(info: JsonObject, model: ModelInfo, familyName: string, dimensions: readonly ModelDimension[]): JsonObject {
  return {
    modelUid: model.id, label: model.name, disabled: model.isDisabled, maxTokens: model.contextWindow,
    supportsImages: model.supportsImages,
    // The recommended flag must survive offline restore so the list filter gives the same result.
    ...(model.isRecommended ? { isRecommended: true } : {}),
    modelInfo: {
      modelUid: model.id, modelFamilyUid: model.familyId || model.id,
      maxTokens: model.contextWindow, maxOutputTokens: model.maxOutputTokens,
      ...(Predicate.isString(info.modelType) ? { modelType: info.modelType } : {}),
      isModelRouter: model.isRouter, aliases: [...(model.aliases ?? [])],
      modelFeatures: {
        supportsImages: model.supportsImages, supportsToolCalls: model.supportsToolCalls,
        supportsParallelToolCalls: model.supportsParallelToolCalls, supportsThinking: model.supportsThinking,
      },
    },
    modelFamilyMetadata: { modelFamilyLabel: familyName, entries: dimensions.map(({ key, order, name }) => ({ key, value: { order, name } })) },
  };
}

function capabilityKey(model: ModelInfo): string {
  return JSON.stringify([model.contextWindow, model.maxOutputTokens, model.supportsImages, model.supportsToolCalls, model.supportsParallelToolCalls]);
}

export function projectModelVariants(catalog: ModelCatalog): Effect.Effect<VariantProjection, DevinError> {
  return Effect.gen(function* () {
    const configs = catalog.raw.clientModelConfigs;
    if (!Array.isArray(configs) || configs.length !== catalog.models.length) return yield* failWith("The raw and projected model lists do not match.");
    const ids = new Set<string>();
    const variants: ModelVariant[] = [];
    for (const [index, original] of catalog.models.entries()) {
      if (ids.has(original.id)) return yield* failWith(`Duplicate model UID: ${original.id}`);
      ids.add(original.id);
      const config = yield* object(configs[index], "model config"), info = yield* object(config.modelInfo, "modelInfo");
      if (config.modelUid !== original.id) return yield* failWith("Model UIDs do not match the raw order.");
      const allDimensions = yield* dimensionsOf(config);
      const family = yield* object(config.modelFamilyMetadata ?? {}, "modelFamilyMetadata");
      const model = { ...original, aliases: [...(original.aliases ?? [])], contextWindow: yield* tokenCount(config.maxTokens ?? original.contextWindow, "context window") };
      const familyName = Predicate.isString(family.modelFamilyLabel) && family.modelFamilyLabel ? family.modelFamilyLabel : model.familyId || model.name;
      const classification = Predicate.isString(info.modelType) && info.modelType !== "MODEL_TYPE_CHAT"
        ? { unsupported: "not a chat model" } : classify(model, allDimensions);
      variants.push({
        model, family: model.familyId || model.id, familyName,
        dimensions: allDimensions.filter((entry) => !thinkingDimensions.has(entry.key)), ...classification,
        config: sanitizedConfig(info, model, familyName, allDimensions),
      });
    }
    const groupMap = new Map<string, VariantGroup>();
    for (const variant of variants) {
      const id = groupModelID(variant.family, variant.dimensions);
      let group = groupMap.get(id);
      if (!group) {
        group = { id, family: variant.family, name: variant.familyName, dimensions: variant.dimensions, variants: [], mappings: {}, canPublish: true };
        groupMap.set(id, group);
      }
      group.variants.push(variant);
      if (variant.level === undefined || variant.unsupported) continue;
      if (group.mappings[variant.level]) { group.canPublish = false; group.reason = "ambiguous UID for thinking level"; }
      else group.mappings[variant.level] = variant.model.id;
    }
    for (const group of groupMap.values()) {
      const supported = group.variants.filter((variant) => variant.level !== undefined && !variant.unsupported);
      if (!supported.length) { group.canPublish = false; group.reason = "no verified thinking mapping"; }
      else if (new Set(supported.map((variant) => capabilityKey(variant.model))).size !== 1) {
        group.canPublish = false; group.reason = "variant capabilities differ; use exact UID";
      }
    }
    return {
      variants, groups: [...groupMap.values()],
      unsupported: variants.flatMap((variant) => variant.unsupported ? [{ uid: variant.model.id, reason: variant.unsupported }] : []),
    };
  });
}

export function restoreModelVariants(configs: readonly JsonObject[]): Effect.Effect<VariantProjection, DevinError> {
  return Effect.flatMap(parseModelCatalog({ clientModelConfigs: [...configs] }), projectModelVariants);
}

/** Accepts only the effective level that Pi already clamped or selected. Never falls back to an alias, price or default model. */
export function resolveBackendSelection(projection: VariantProjection, modelID: string, level: EffectiveThinkingLevel): Effect.Effect<BackendModelSelection, DevinError> {
  return Effect.gen(function* () {
    if (!EFFECTIVE_THINKING_LEVELS.includes(level)) return yield* failWith(`Unsupported thinking level: ${level}`);
    let variant = projection.variants.find((entry) => modelIDForUID(entry.model.id) === modelID);
    if (variant) {
      if (variant.unsupported || variant.level !== level) return yield* failWith(`This exact UID does not support the requested thinking level: ${modelID} (${level})`);
    } else {
      const group = projection.groups.find((entry) => entry.id === modelID);
      const uid = group?.canPublish ? group.mappings[level] : undefined;
      variant = uid === undefined ? undefined : projection.variants.find((entry) => entry.model.id === uid);
      if (!variant) return yield* failWith(`Model or thinking level unavailable: ${modelID} (${level})`);
    }
    const model = yield* getModelByUID(projection.variants.map((entry) => entry.model), variant.model.id);
    return { uid: model.id, model, level, variant };
  });
}
