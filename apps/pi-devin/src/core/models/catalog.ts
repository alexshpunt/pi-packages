import { object, requiredString, tokenCount, type JsonObject, type ModelInfo } from "../types.ts";

export interface ModelCatalog { raw: JsonObject; models: ModelInfo[]; defaultModelUid?: string }

export function parseModelCatalog(response: JsonObject): ModelCatalog {
  if (!Array.isArray(response.clientModelConfigs)) throw new Error("clientModelConfigs is missing.");
  const override = object(response.defaultOverrideModelConfig ?? {}, "defaultOverrideModelConfig");
  const defaultModelUid = typeof override.modelUid === "string" ? override.modelUid : undefined;
  const models = response.clientModelConfigs.map((value) => {
    const config = object(value, "ClientModelConfig");
    const info = object(config.modelInfo, "modelInfo");
    const features = object(info.modelFeatures ?? {}, "modelFeatures");
    const family = object(config.modelFamilyMetadata ?? {}, "modelFamilyMetadata");
    return {
      id: requiredString(config.modelUid, "modelUid"),
      name: requiredString(config.label, "label"),
      contextWindow: tokenCount(info.maxTokens ?? 0, "context window"),
      maxOutputTokens: tokenCount(info.maxOutputTokens ?? 0, "max output tokens"),
      supportsThinking: features.supportsThinking === true,
      supportsImages: config.supportsImages === true || features.supportsImages === true,
      supportsToolCalls: features.supportsToolCalls === true,
      supportsParallelToolCalls: features.supportsParallelToolCalls === true,
      isRouter: info.isModelRouter === true,
      isDisabled: config.disabled === true,
      familyId: typeof info.modelFamilyUid === "string" ? info.modelFamilyUid : undefined,
      aliases: Array.isArray(info.aliases) ? info.aliases.filter((value): value is string => typeof value === "string") : [],
      isDefaultInFamily: config.isDefaultModelInFamily === true || family.isDefaultModelInFamily === true,
      isRecommended: config.isRecommended === true,
      costTier: typeof config.modelCostTier === "string" ? config.modelCostTier : undefined,
      creditMultiplier: typeof config.creditMultiplier === "number" ? config.creditMultiplier : undefined,
      pricingType: typeof config.pricingType === "string" ? config.pricingType : undefined,
    };
  });
  return { raw: response, models, defaultModelUid };
}
