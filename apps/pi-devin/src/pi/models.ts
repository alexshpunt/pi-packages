import { createHash } from "node:crypto";
import type { Credential as HostCredential, Model, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { awaitWithSignal, endpoint } from "../core/protocol/transport.ts";
import { object, type Credential, type JsonObject } from "../core/types.ts";
import type { ModelCatalog } from "../core/models/catalog.ts";
import {
  EFFECTIVE_THINKING_LEVELS, modelIDForUID, projectModelVariants, resolveBackendSelection, restoreModelVariants,
  type BackendModelSelection, type EffectiveThinkingLevel, type ModelVariant, type VariantProjection,
} from "../core/models/variants.ts";

export const DEVIN_API = "devin-connect";
const CATALOG_VERSION = 1;
const DEFAULT_FRESHNESS_MS = 5 * 60_000;
/** Default sidekick when nothing is saved or the saved one is gone. The default lead is the group this UID belongs to. */
export const FUSION_SIDEKICK_UID = "swe-2-medium";
/** The single Fusion entry shown in `/model`. Lead and sidekick follow the global `/devin-fusion` choice. */
export const FUSION_MODEL_ID = "fusion";
/** The lead is a published group model ID; the sidekick is an exact variant model ID. Both come from `publicModelIDs`. */
export interface FusionSelection { leadID: string; sidekickID: string }
export interface FusionChoices {
  leads: { id: string; name: string; recommended?: true }[];
  /** `level` is the thinking level of this UID. It is passed to the sidekick child Pi as is. */
  sidekicks: { id: string; name: string; groupName: string; level: EffectiveThinkingLevel; recommended?: true }[];
}
export interface DevinModel extends Model<typeof DEVIN_API> {
  devin: {
    version: number; scope: string; costsUnknown: true; configs: JsonObject[]; unavailable?: JsonObject[];
    fusion?: FusionSelection;
    /** Marked as recommended by the catalog. For a group, true when any variant is recommended. */
    recommended?: true;
    /** Account identity hash (endpoint and user ID) the catalog belongs to. Lets a new session of the same account reuse it. */
    account?: string;
  };
}

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

export function isFusionModelID(id: string): boolean { return id === FUSION_MODEL_ID; }

/**
 * A model whose catalog entry marks 24-hour prompt cache retention as a variant attribute.
 * The request wire has no retention field, so this flag is the only basis for allowing long retention.
 */
export function hasExtendedPromptCacheRetention(variant: ModelVariant): boolean {
  return variant.dimensions.some((dimension) => dimension.key === "Prompt Cache Retention" && dimension.name === "24h");
}

export function catalogScope(credential: Credential): string {
  return createHash("sha256").update(endpoint(credential.apiServerURL) + "\0" + credential.sessionToken).digest("hex");
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

type VariantGroup = VariantProjection["groups"][number];
const byModelID = (a: ModelVariant, b: ModelVariant) => a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
const isUsable = (variant: ModelVariant) => variant.level !== undefined && !variant.unsupported;
const publishedVariants = (group: VariantGroup) => group.variants.filter(isUsable).sort(byModelID);

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
function groupDisplayNames(projection: VariantProjection): Map<string, string> {
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

const ACCOUNT_HASH = /^[a-f0-9]{64}$/;
interface RestoredCatalog { projection: VariantProjection; account?: string; isSameSession: boolean }

/**
 * Restores the stored catalog of the same session, or of an earlier session of an account this process verified for `account`.
 * Every entry must share one scope and one account, so a mixed or edited cache is never partly applied.
 */
function restoredCatalog(stored: Readonly<ModelsStoreEntry> | undefined, credential: Credential, account: string | undefined): RestoredCatalog | undefined {
  if (!stored?.models.length) return undefined;
  const scope = catalogScope(credential), configs = new Map<string, JsonObject>();
  let storedScope: unknown, storedAccount: unknown;
  for (const [index, model] of stored.models.entries()) {
    const metadata = object((model as DevinModel).devin, "cached Devin metadata");
    if ((model.type !== undefined && model.type !== "chat") || model.provider !== "devin" || model.api !== DEVIN_API || model.baseUrl !== credential.apiServerURL
      || metadata.version !== CATALOG_VERSION || typeof metadata.scope !== "string") return undefined;
    if (metadata.account !== undefined && (typeof metadata.account !== "string" || !ACCOUNT_HASH.test(metadata.account))) return undefined;
    if (index === 0) { storedScope = metadata.scope; storedAccount = metadata.account; }
    else if (metadata.scope !== storedScope || metadata.account !== storedAccount) return undefined;
    if (!Array.isArray(metadata.configs)) return undefined;
    const entries = [...metadata.configs, ...(Array.isArray(metadata.unavailable) ? metadata.unavailable : [])];
    for (const value of entries) {
      const config = object(value, "cached model config");
      if (typeof config.modelUid !== "string") return undefined;
      const previous = configs.get(config.modelUid);
      if (previous && JSON.stringify(previous) !== JSON.stringify(config)) return undefined;
      configs.set(config.modelUid, config);
    }
  }
  const isSameSession = storedScope === scope;
  // Another session's catalog is used only for the same verified account; account changes and logout never expose it.
  if (!isSameSession && (account === undefined || storedAccount !== account)) return undefined;
  return { projection: restoreModelVariants([...configs.values()]), account: account ?? storedAccount as string | undefined, isSameSession };
}

export interface DevinModelSource {
  getModels(): readonly DevinModel[];
  filterModels(models: readonly Model<typeof DEVIN_API>[], credential: HostCredential | undefined): readonly Model<typeof DEVIN_API>[];
  refreshModels(context: RefreshModelsContext): Promise<void>;
  resolve(modelID: string, level: EffectiveThinkingLevel, credential: Credential): BackendModelSelection;
  /** Resolves a catalog UID chosen by a payload hook at that variant's thinking level, including UIDs hidden from the list. */
  resolveUID(uid: string, credential: Credential): BackendModelSelection;
  getUnsupported(): readonly { uid: string; reason: string }[];
  /** Thinking level of a usable exact UID in the current catalog, including hidden ones. */
  exactLevel(uid: string): EffectiveThinkingLevel | undefined;
  /** Fusion candidates of the current catalog. undefined without a catalog or when the source has Fusion disabled. */
  getFusionChoices(): FusionChoices | undefined;
  /** Rebuilds the model list from the current catalog without network after a saved choice or setting changes. */
  rebuildModels(): void;
  /** Scope of the credential seen by the last model refresh, even before its catalog loads. Undefined after logout or sign-in. */
  currentScope(): string | undefined;
  invalidate(): void;
}

export function createDevinModelSource(options: {
  credentialFromHost: (credential: HostCredential | undefined) => Credential | undefined;
  fetchCatalog: (credential: Credential, signal: AbortSignal) => Promise<ModelCatalog>;
  now?: () => number;
  freshnessMs?: number;
  /** Reads the saved Fusion choice. false creates no Fusion entry. */
  fusion?: false | (() => FusionSelection | undefined);
  /** Reads the saved recommended filter setting. */
  recommendedOnly?: () => boolean;
  /** Also lists exact UIDs that a group already covers. Used only by the sidekick child Pi. */
  listsAllExactModels?: boolean;
  /** Account identity hash this process verified for the credential, if any. */
  accountOf?: (credential: Credential) => string | undefined;
}): DevinModelSource {
  const now = options.now ?? Date.now, freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  if (!Number.isSafeInteger(freshnessMs) || freshnessMs < 0) throw new Error("The model cache check interval must be an integer of 0 or more.");
  const readFusion = options.fusion;
  // The stored list is shared by every Pi process that uses the lead's agent directory. Only the default list is stored,
  // without display filters or the sidekick-only exact list. It still holds every catalog config, so each process rebuilds its own list after restore.
  const build = (next: VariantProjection, credential: Credential, account: string | undefined, isForStorage = false) => modelsFromProjection(next, credential, {
    fusion: readFusion === false ? false : readFusion?.(),
    recommendedOnly: !isForStorage && options.recommendedOnly?.() === true,
    listsAllExactModels: !isForStorage && options.listsAllExactModels === true,
    account,
  });
  let models: DevinModel[] = [], projection: VariantProjection | undefined, scope: string | undefined, catalogAccount: string | undefined;
  let checkedAtMs = 0, endpointOverride: string | undefined, modelCredential: Credential | undefined, credentialScope: string | undefined;
  const clear = () => {
    models = []; projection = undefined; scope = undefined; catalogAccount = undefined; checkedAtMs = 0; modelCredential = undefined; credentialScope = undefined;
  };
  const currentProjection = (credential: Credential) => {
    if (!projection || scope !== catalogScope(credential)) throw new Error("No Devin model list matches the current account and endpoint. Refresh the model list.");
    return projection;
  };
  const effectiveCredential = (credential: HostCredential | undefined, baseUrl?: string) => {
    const resolved = options.credentialFromHost(credential);
    return resolved ? { ...resolved, apiServerURL: endpoint(baseUrl ?? resolved.apiServerURL) } : undefined;
  };
  return {
    getModels: () => models,
    getUnsupported: () => projection?.unsupported ?? [],
    exactLevel: (uid) => projection?.variants.find((variant) => variant.model.id === uid && isUsable(variant))?.level,
    getFusionChoices: () => projection && readFusion !== false ? fusionChoices(projection) : undefined,
    rebuildModels() {
      if (projection && modelCredential) models = build(projection, modelCredential, catalogAccount);
    },
    currentScope: () => credentialScope,
    invalidate: clear,
    filterModels(candidates, credential) {
      try {
        const resolved = effectiveCredential(credential, endpointOverride);
        if (!resolved) return [];
        const expected = catalogScope(resolved);
        return candidates.filter((model) => model.provider === "devin" && model.api === DEVIN_API && model.baseUrl === resolved.apiServerURL && (model as DevinModel).devin?.scope === expected);
      } catch { return []; }
    },
    resolve(modelID, level, credential) {
      const current = currentProjection(credential);
      let wanted = modelID;
      if (isFusionModelID(modelID)) {
        // Fusion lead requests use the same UID and thinking level as the selected lead group.
        const fusion = models.find((model) => model.id === modelID)?.devin.fusion;
        if (!fusion) throw new Error(`Fusion model unavailable: ${modelID}`);
        wanted = fusion.leadID;
      }
      const target = publicModelIDs(current).targets.get(wanted);
      if (!target) throw new Error(`Model or thinking level unavailable: ${modelID} (${level})`);
      return resolveBackendSelection(current, "group" in target ? target.group.id : modelIDForUID(target.variant.model.id), level);
    },
    resolveUID(uid, credential) {
      const current = currentProjection(credential);
      const level = current.variants.find((variant) => variant.model.id === uid && isUsable(variant))?.level;
      if (!level) throw new Error(`Model UID unavailable: ${uid}`);
      return resolveBackendSelection(current, modelIDForUID(uid), level);
    },
    async refreshModels(context) {
      context.signal.throwIfAborted();
      const credential = effectiveCredential(context.credential, context.baseUrl);
      if (!credential) {
        await context.publish({ update: clear });
        return;
      }
      const expectedScope = catalogScope(credential);
      let restored: RestoredCatalog | undefined;
      try { restored = restoredCatalog(context.stored, credential, options.accountOf?.(credential)); }
      catch { /* A bad cache is never used as run data. The current good state is kept. */ }
      if (restored && (scope !== expectedScope || !projection || (context.stored?.checkedAt ?? 0) > checkedAtMs)) {
        const { projection: restoredProjection, account: restoredAccount, isSameSession } = restored;
        const restoredModels = build(restoredProjection, credential, restoredAccount);
        const checkedAt = context.stored?.checkedAt;
        const restoredAtMs = typeof checkedAt === "number" && Number.isFinite(checkedAt) && checkedAt >= 0 && checkedAt <= now() ? checkedAt : 0;
        const accepted = await context.publish({
          // A catalog reused for a new session of the same account is stored under the new session, so a restart restores it too.
          ...(isSameSession ? {} : { persist: { models: build(restoredProjection, credential, restoredAccount, true), checkedAt: restoredAtMs } }),
          update: () => {
            projection = restoredProjection; models = restoredModels; scope = expectedScope; catalogAccount = restoredAccount; modelCredential = credential;
            checkedAtMs = restoredAtMs; endpointOverride = context.baseUrl; credentialScope = expectedScope;
          },
        });
        if (!accepted) return;
      } else if (scope !== expectedScope || endpointOverride !== context.baseUrl || credentialScope !== expectedScope) {
        const accepted = await context.publish({ update: () => {
          if (scope !== expectedScope || endpointOverride !== context.baseUrl) clear();
          endpointOverride = context.baseUrl; credentialScope = expectedScope;
        } });
        if (!accepted) return;
      }
      if (!context.allowNetwork) return;
      const ageMs = now() - checkedAtMs;
      if (!context.force && scope === expectedScope && projection && checkedAtMs > 0 && ageMs >= 0 && ageMs < freshnessMs) return;
      const catalog = await awaitWithSignal(options.fetchCatalog(credential, context.signal), context.signal);
      context.signal.throwIfAborted();
      const nextProjection = projectModelVariants(catalog);
      // Known after an account check in this process, or carried over from this same session's catalog.
      const nextAccount = options.accountOf?.(credential) ?? (scope === expectedScope ? catalogAccount : undefined);
      const nextModels = build(nextProjection, credential, nextAccount);
      const checkedAt = now();
      if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) throw new Error("Invalid model cache check time.");
      await context.publish({
        persist: { models: build(nextProjection, credential, nextAccount, true), checkedAt },
        update: () => {
          projection = nextProjection; models = nextModels; scope = expectedScope; catalogAccount = nextAccount; modelCredential = credential;
          checkedAtMs = checkedAt; endpointOverride = context.baseUrl; credentialScope = expectedScope;
        },
      });
    },
  };
}
