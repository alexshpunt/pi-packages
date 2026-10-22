import type { ModelVariant, VariantProjection } from "../../../core/models/variants.ts";
import { FUSION_MODEL_ID } from "./constants.ts";

export type VariantGroup = VariantProjection["groups"][number];
export const byModelID = (a: ModelVariant, b: ModelVariant) => a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
export const isUsable = (variant: ModelVariant) => variant.level !== undefined && !variant.unsupported;
export const publishedVariants = (group: VariantGroup) => group.variants.filter(isUsable).sort(byModelID);

/**
 * Dimension labels that tell groups apart: only dimensions whose values differ among published groups of the same family name.
 * When the catalog value name is empty, 0 counts as the default and is omitted; an enabled value uses the dimension name.
 */
function groupDistinctParts(projection: VariantProjection): Map<string, string[]> {
  const families = new Map<string, VariantGroup[]>();
  for (const group of projection.groups) families.set(group.name, [...(families.get(group.name) ?? []), group]);
  const result = new Map<string, string[]>();
  for (const groups of families.values()) {
    const peers = groups.filter((group) => group.canPublish).length > 1 ? groups.filter((group) => group.canPublish) : groups;
    const values = (key: string) => new Set(peers.map((group) => {
      const dimension = group.dimensions.find((entry) => entry.key === key);
      return dimension ? `${dimension.order}\0${dimension.name}` : "";
    }));
    for (const group of groups) {
      const parts = group.dimensions.filter((dimension) => values(dimension.key).size > 1).flatMap((dimension) => {
        if (dimension.name) return [`${dimension.key} ${dimension.name}`];
        if (dimension.order === 0) return [];
        const orders = new Set(peers.map((peer) => peer.dimensions.find((entry) => entry.key === dimension.key)).filter((entry) => entry && !entry.name && entry.order !== 0).map((entry) => entry!.order));
        return [orders.size > 1 ? `${dimension.key} ${dimension.order}` : dimension.key];
      });
      result.set(group.id, parts);
    }
  }
  return result;
}

/** Human-readable group name. Example: `Claude Opus 4.8 · Fast Mode`. */
export function groupDisplayNames(projection: VariantProjection): Map<string, string> {
  const parts = groupDistinctParts(projection);
  return new Map(projection.groups.map((group) => [group.id, [group.name, ...parts.get(group.id)!].join(" · ")]));
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");

/** Model IDs shown in Pi lists. Groups are keyed by their internal `family:` key, variants by catalog UID. */
export interface PublicModelIDs {
  groups: ReadonlyMap<string, string>;
  variants: ReadonlyMap<string, string>;
  targets: ReadonlyMap<string, { group: VariantGroup } | { variant: ModelVariant }>;
}

const publicIDCache = new WeakMap<VariantProjection, PublicModelIDs>();
/**
 * Pi `/model` shows IDs, not model names, so the IDs are made human-readable.
 * Published groups use `familyID[-differing dimensions]` (e.g. `claude-opus-4.8-fast-mode`); variants use the catalog UID (e.g. `swe-2-high`).
 * The same catalog always yields the same IDs regardless of display mode. On a clash, groups win and the variant gets `-exact`.
 */
export function publicModelIDs(projection: VariantProjection): PublicModelIDs {
  const cached = publicIDCache.get(projection);
  if (cached) return cached;
  const parts = groupDistinctParts(projection), taken = new Set([FUSION_MODEL_ID]);
  const groups = new Map<string, string>(), variants = new Map<string, string>(), targets = new Map<string, { group: VariantGroup } | { variant: ModelVariant }>();
  const claim = (base: string) => {
    let id = base;
    for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
    taken.add(id);
    return id;
  };
  for (const group of projection.groups.filter((entry) => entry.canPublish).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const id = claim([slug(group.family), ...parts.get(group.id)!.map(slug)].filter(Boolean).join("-") || "model");
    groups.set(group.id, id); targets.set(id, { group });
  }
  for (const variant of projection.variants.filter(isUsable).sort(byModelID)) {
    const id = claim(taken.has(variant.model.id) ? `${variant.model.id}-exact` : variant.model.id);
    variants.set(variant.model.id, id); targets.set(id, { variant });
  }
  const result = { groups, variants, targets };
  publicIDCache.set(projection, result);
  return result;
}
