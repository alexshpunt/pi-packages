import type { VariantProjection } from "../../../core/models/variants.ts";
import { DEVIN_API, FUSION_SIDEKICK_UID } from "./constants.ts";
import { byModelID, groupDisplayNames, isUsable, publicModelIDs, publishedVariants, type VariantGroup } from "./ids.ts";
import type { DevinModel, FusionChoices, FusionSelection } from "./types.ts";

/**
 * Fusion candidates. The lead must call the sidekick tool and the sidekick works with Pi tools, so
 * only models that support tool calls qualify. All variants of a published group share capabilities.
 */
export function fusionChoices(projection: VariantProjection): FusionChoices {
  const names = groupDisplayNames(projection), ids = publicModelIDs(projection);
  const leads = projection.groups.filter((group) => group.canPublish && publishedVariants(group)[0]?.model.supportsToolCalls)
    .map((group) => ({ id: ids.groups.get(group.id)!, name: names.get(group.id)!,
      ...(group.variants.some((variant) => variant.model.isRecommended) ? { recommended: true as const } : {}) }));
  const groupOf = new Map<string, VariantGroup>();
  for (const group of projection.groups) for (const variant of group.variants) groupOf.set(variant.model.id, group);
  const sidekicks = projection.variants.filter((variant) => isUsable(variant) && variant.model.supportsToolCalls).sort(byModelID)
    .map((variant) => {
      const group = groupOf.get(variant.model.id);
      return { id: ids.variants.get(variant.model.id)!, name: variant.model.name, groupName: group ? names.get(group.id)! : variant.model.name, level: variant.level!,
        ...(variant.model.isRecommended ? { recommended: true as const } : {}) };
    });
  return { leads, sidekicks };
}

/** Saved values missing from the current list fall back to the defaults per item. Without defaults, no Fusion entry is built. */
export function effectiveFusion(projection: VariantProjection, requested: FusionSelection | undefined): FusionSelection | undefined {
  const { leads, sidekicks } = fusionChoices(projection), ids = publicModelIDs(projection);
  const defaultSidekick = ids.variants.get(FUSION_SIDEKICK_UID);
  const defaultGroup = projection.groups.find((group) => group.variants.some((variant) => variant.model.id === FUSION_SIDEKICK_UID));
  const defaultLead = defaultGroup && ids.groups.get(defaultGroup.id);
  // A choice saved in the legacy format (`family:…`, `uid:…`) is read as the same model's new ID.
  const current = (id: string | undefined) => id?.startsWith("family:") ? ids.groups.get(id)
    : id?.startsWith("uid:") ? ids.variants.get(decodeURIComponent(id.slice("uid:".length))) : id;
  const pick = (options: readonly { id: string }[], wanted: string | undefined, fallback: string | undefined) =>
    options.find((option) => option.id === current(wanted))?.id ?? options.find((option) => option.id === fallback)?.id;
  const leadID = pick(leads, requested?.leadID, defaultLead), sidekickID = pick(sidekicks, requested?.sidekickID, defaultSidekick);
  return leadID && sidekickID ? { leadID, sidekickID } : undefined;
}

/** The Fusion pair of the lead's model. The host may copy model objects in its settings layer, so the pair is looked up by ID in the current list. */
export function fusionOf(models: readonly DevinModel[], model: { provider?: string; api?: string; id: string } | undefined): FusionSelection | undefined {
  if (model?.provider !== "devin" || model.api !== DEVIN_API) return undefined;
  return models.find((candidate) => candidate.id === model.id)?.devin.fusion;
}
