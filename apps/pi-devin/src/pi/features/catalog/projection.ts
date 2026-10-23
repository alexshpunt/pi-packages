import { createHash } from "node:crypto";
import { EFFECTIVE_THINKING_LEVELS, type EffectiveThinkingLevel, type ModelVariant, type VariantProjection } from "../../../core/models/variants.ts";
import type { Credential } from "../../../core/types.ts";
import { CATALOG_VERSION, DEVIN_API, FUSION_MODEL_ID } from "./constants.ts";
import { effectiveFusion } from "./fusion.ts";
import { groupDisplayNames, isUsable, publicModelIDs, publishedVariants } from "./ids.ts";
import type { DevinModel, FusionSelection } from "./types.ts";

/** Options for projecting the model list. Defaults: group list, Fusion included, recommended filter off. */
export interface ProjectionOptions {
  /** Saved Fusion choice. false (sidekick child Pi) creates no Fusion entry. */
  fusion?: FusionSelection | false;
  /** Lists only models with a variant marked as recommended. Groups stay groups. The Fusion entry is unaffected. */
  recommendedOnly?: boolean;
  /** Also lists exact UIDs that a group already covers. Used only by the sidekick child Pi. */
  listsAllExactModels?: boolean;
  /** Account identity hash recorded with every model. */
  account?: string;
}

/**
 * A model whose catalog entry marks 24-hour prompt cache retention as a variant attribute.
 * The request wire has no retention field, so this flag is the only basis for allowing long retention.
 */
export function hasExtendedPromptCacheRetention(variant: ModelVariant): boolean {
  return variant.dimensions.some((dimension) => dimension.key === "Prompt Cache Retention" && dimension.name === "24h");
}

/** Scope of one credential on one endpoint. Credentials reaching here already carry a validated endpoint origin. */
export function catalogScope(credential: Credential): string {
  return createHash("sha256").update(credential.apiServerURL + "\0" + credential.sessionToken).digest("hex");
}

function thinkingMap(mappings: Partial<Record<EffectiveThinkingLevel, string>>) {
  return Object.fromEntries(EFFECTIVE_THINKING_LEVELS.map((level) => [level, mappings[level] ?? null]));
}

function modelDefinition(id: string, name: string, variants: ModelVariant[], mappings: Partial<Record<EffectiveThinkingLevel, string>>, credential: Credential, account?: string): DevinModel {
  const first = variants[0].model;
  return {
    id, name, api: DEVIN_API, provider: "devin", baseUrl: credential.apiServerURL,
    reasoning: Object.keys(mappings).some((level) => level !== "off"), thinkingLevelMap: thinkingMap(mappings),
    input: first.supportsImages ? ["text", "image"] : ["text"],
    contextWindow: first.contextWindow, maxTokens: first.maxOutputTokens,
    // Placeholder for Pi's required numeric fields. It does not mean free or a real USD price.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    devin: { version: CATALOG_VERSION, scope: catalogScope(credential), costsUnknown: true, configs: variants.map((variant) => variant.config), ...(account ? { account } : {}) },
  };
}

/**
 * Exact UIDs covered by a published group are hidden and chosen with `/thinking`. Their catalog configs are stored on the group model.
 * `recommendedOnly` keeps only groups and uncovered exact UIDs that hold a recommended variant, so `/thinking` still picks the UID.
 * Without any recommended variant, it falls back to the default list.
 * `listsAllExactModels` is only for processes that pick exact UIDs directly, such as the sidekick child.
 */
export function modelsFromProjection(projection: VariantProjection, credential: Credential, options: ProjectionOptions = {}): DevinModel[] {
  const models: DevinModel[] = [], names = groupDisplayNames(projection), ids = publicModelIDs(projection);
  const published = projection.groups.filter((group) => group.canPublish);
  const recommendedUIDs = new Set(projection.variants.filter((variant) => isUsable(variant) && variant.model.isRecommended).map((variant) => variant.model.id));
  // Fall back to the default projection so accounts without recommended flags never get an empty list.
  const isRecommendedOnly = options.recommendedOnly === true && recommendedUIDs.size > 0;
  const isListed = (uids: readonly string[]) => !isRecommendedOnly || uids.some((uid) => recommendedUIDs.has(uid));
  for (const group of published) {
    if (!isListed(Object.values(group.mappings))) continue;
    const model = modelDefinition(ids.groups.get(group.id)!, names.get(group.id)!, publishedVariants(group), group.mappings, credential, options.account);
    if (group.variants.some((variant) => variant.model.isRecommended)) model.devin.recommended = true;
    models.push(model);
  }
  const covered = new Set(published.flatMap((group) => Object.values(group.mappings)));
  const exact = projection.variants.filter((variant) => isUsable(variant) && isListed([variant.model.id])
    && (options.listsAllExactModels === true || !covered.has(variant.model.id)));
  const listedNames = new Set(models.map((model) => model.name));
  for (const variant of exact) {
    const name = listedNames.has(variant.model.name) ? `${variant.model.name} (${variant.model.id})` : variant.model.name;
    const model = modelDefinition(ids.variants.get(variant.model.id)!, name, [variant], { [variant.level!]: variant.model.id }, credential, options.account);
    if (variant.model.isRecommended) model.devin.recommended = true;
    models.push(model);
  }
  const fusion = options.fusion;
  const pair = fusion === false ? undefined : effectiveFusion(projection, fusion);
  if (pair) {
    const lead = projection.groups.find((group) => ids.groups.get(group.id) === pair.leadID)!;
    const sidekick = projection.variants.find((variant) => ids.variants.get(variant.model.id) === pair.sidekickID)!;
    const model = modelDefinition(FUSION_MODEL_ID, `Devin Fusion · ${names.get(lead.id)} + ${sidekick.model.name}`, publishedVariants(lead), lead.mappings, credential, options.account);
    model.devin.fusion = pair;
    models.push(model);
  }
  models.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (models.length) models[0].devin.unavailable = projection.variants.filter((variant) => variant.unsupported)
    .sort((a, b) => a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0).map((variant) => variant.config);
  return models;
}
