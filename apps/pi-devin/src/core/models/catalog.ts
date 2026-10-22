import { Effect, Predicate } from "effect";
import type { DevinError } from "../errors.ts";
import type { JsonObject, ModelInfo } from "../types.ts";
import { failWith, object, requiredString, tokenCount } from "../validation.ts";

export interface ModelCatalog { raw: JsonObject; models: ModelInfo[]; defaultModelUid?: string }

function parseModel(value: unknown): Effect.Effect<ModelInfo, DevinError> {
  return Effect.gen(function* () {
    const config = yield* object(value, "ClientModelConfig");
    const info = yield* object(config.modelInfo, "modelInfo");
    const features = yield* object(info.modelFeatures ?? {}, "modelFeatures");
    const family = yield* object(config.modelFamilyMetadata ?? {}, "modelFamilyMetadata");
    return {
      id: yield* requiredString(config.modelUid, "modelUid"),
      name: yield* requiredString(config.label, "label"),
      contextWindow: yield* tokenCount(info.maxTokens ?? 0, "context window"),
      maxOutputTokens: yield* tokenCount(info.maxOutputTokens ?? 0, "max output tokens"),
      supportsThinking: features.supportsThinking === true,
      supportsImages: config.supportsImages === true || features.supportsImages === true,
      supportsToolCalls: features.supportsToolCalls === true,
      supportsParallelToolCalls: features.supportsParallelToolCalls === true,
      isRouter: info.isModelRouter === true,
      isDisabled: config.disabled === true,
      familyId: Predicate.isString(info.modelFamilyUid) ? info.modelFamilyUid : undefined,
      aliases: Array.isArray(info.aliases) ? info.aliases.filter(Predicate.isString) : [],
      isDefaultInFamily: config.isDefaultModelInFamily === true || family.isDefaultModelInFamily === true,
      isRecommended: config.isRecommended === true,
      costTier: Predicate.isString(config.modelCostTier) ? config.modelCostTier : undefined,
      creditMultiplier: Predicate.isNumber(config.creditMultiplier) ? config.creditMultiplier : undefined,
      pricingType: Predicate.isString(config.pricingType) ? config.pricingType : undefined,
    };
  });
}

export function parseModelCatalog(response: JsonObject): Effect.Effect<ModelCatalog, DevinError> {
  return Effect.gen(function* () {
    if (!Array.isArray(response.clientModelConfigs)) return yield* failWith("clientModelConfigs is missing.");
    const override = yield* object(response.defaultOverrideModelConfig ?? {}, "defaultOverrideModelConfig");
    const defaultModelUid = Predicate.isString(override.modelUid) ? override.modelUid : undefined;
    const models = yield* Effect.forEach(response.clientModelConfigs, parseModel);
    return { raw: response, models, defaultModelUid };
  });
}
