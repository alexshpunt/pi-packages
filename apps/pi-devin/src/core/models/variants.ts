import { object, requiredString, tokenCount, type JsonObject, type ModelInfo } from "../types.ts";
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

function dimensionsOf(config: JsonObject): ModelDimension[] {
  const family = object(config.modelFamilyMetadata ?? {}, "modelFamilyMetadata");
  if (family.entries === undefined) return [];
  if (!Array.isArray(family.entries)) throw new Error("Model dimension entries are not an array.");
  const seen = new Set<string>();
  return family.entries.map((item) => {
    const entry = object(item, "model dimension"), value = object(entry.value ?? {}, "dimension value");
    const key = requiredString(entry.key, "dimension key");
    if (seen.has(key)) throw new Error(`Duplicate model dimension: ${key}`);
    seen.add(key);
    const order = tokenCount(value.order ?? 0, "dimension order");
    if (!Number.isSafeInteger(order)) throw new Error("The model dimension order must be an integer.");
    return { key, order, name: typeof value.name === "string" ? value.name : "" };
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
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

function sanitizedConfig(config: JsonObject, model: ModelInfo, familyName: string, dimensions: readonly ModelDimension[]): JsonObject {
  const info = object(config.modelInfo, "modelInfo");
  return {
    modelUid: model.id, label: model.name, disabled: model.isDisabled, maxTokens: model.contextWindow,
    supportsImages: model.supportsImages,
    // The recommended flag must survive offline restore so the list filter gives the same result.
    ...(model.isRecommended ? { isRecommended: true } : {}),
    modelInfo: {
      modelUid: model.id, modelFamilyUid: model.familyId || model.id,
      maxTokens: model.contextWindow, maxOutputTokens: model.maxOutputTokens,
      ...(typeof info.modelType === "string" ? { modelType: info.modelType } : {}),
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

export function projectModelVariants(catalog: ModelCatalog): VariantProjection {
  const configs = catalog.raw.clientModelConfigs;
  if (!Array.isArray(configs) || configs.length !== catalog.models.length) throw new Error("The raw and projected model lists do not match.");
  const ids = new Set<string>();
  const variants = catalog.models.map((original, index): ModelVariant => {
    if (ids.has(original.id)) throw new Error(`Duplicate model UID: ${original.id}`);
    ids.add(original.id);
    const config = object(configs[index], "model config"), info = object(config.modelInfo, "modelInfo");
    if (config.modelUid !== original.id) throw new Error("Model UIDs do not match the raw order.");
    const allDimensions = dimensionsOf(config);
    const family = object(config.modelFamilyMetadata ?? {}, "modelFamilyMetadata");
    const model = { ...original, aliases: [...(original.aliases ?? [])], contextWindow: tokenCount(config.maxTokens ?? original.contextWindow, "context window") };
    const familyName = typeof family.modelFamilyLabel === "string" && family.modelFamilyLabel ? family.modelFamilyLabel : model.familyId || model.name;
    const classification = typeof info.modelType === "string" && info.modelType !== "MODEL_TYPE_CHAT"
      ? { unsupported: "not a chat model" } : classify(model, allDimensions);
    return {
      model, family: model.familyId || model.id, familyName,
      dimensions: allDimensions.filter((entry) => !thinkingDimensions.has(entry.key)), ...classification,
      config: sanitizedConfig(config, model, familyName, allDimensions),
    };
  });
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
  return { variants, groups: [...groupMap.values()], unsupported: variants.filter((variant) => variant.unsupported).map((variant) => ({ uid: variant.model.id, reason: variant.unsupported! })) };
}

export function restoreModelVariants(configs: readonly JsonObject[]): VariantProjection {
  return projectModelVariants(parseModelCatalog({ clientModelConfigs: [...configs] }));
}

/** Accepts only the effective level that Pi already clamped or selected. Never falls back to an alias, price or default model. */
export function resolveBackendSelection(projection: VariantProjection, modelID: string, level: EffectiveThinkingLevel): BackendModelSelection {
  if (!EFFECTIVE_THINKING_LEVELS.includes(level)) throw new Error(`Unsupported thinking level: ${level}`);
  let variant = projection.variants.find((entry) => modelIDForUID(entry.model.id) === modelID);
  if (variant) {
    if (variant.unsupported || variant.level !== level) throw new Error(`This exact UID does not support the requested thinking level: ${modelID} (${level})`);
  } else {
    const group = projection.groups.find((entry) => entry.id === modelID);
    const uid = group?.canPublish ? group.mappings[level] : undefined;
    if (!uid) throw new Error(`Model or thinking level unavailable: ${modelID} (${level})`);
    variant = projection.variants.find((entry) => entry.model.id === uid)!;
  }
  const model = getModelByUID(projection.variants.map((entry) => entry.model), variant.model.id);
  return { uid: model.id, model, level, variant };
}
