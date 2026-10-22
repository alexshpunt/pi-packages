import type { Credential as HostCredential, ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import { Context, Effect, Layer } from "effect";
import { abortWith } from "../../../core/cancellation.ts";
import { toDevinFailure } from "../../../core/errors.ts";
import { modelIDForUID, projectModelVariants, resolveBackendSelection, type VariantProjection } from "../../../core/models/variants.ts";
import { endpoint } from "../../../core/protocol/endpoint.ts";
import type { Credential } from "../../../core/types.ts";
import { failWith } from "../../../core/validation.ts";
import { ExtensionConfig } from "../../app/config.ts";
import { Accounts } from "../accounts/service.ts";
import { CredentialGuard } from "../auth/guard.ts";
import { AuthState } from "../auth/state.ts";
import { ProviderLifetime } from "../lifetime/service.ts";
import { DisplaySettings, FusionSettings } from "../settings/service.ts";
import { UsageChanges } from "../usage/changes.ts";
import { DEVIN_API, isFusionModelID } from "./constants.ts";
import { fusionChoices } from "./fusion.ts";
import { isUsable, publicModelIDs } from "./ids.ts";
import { catalogScope, modelsFromProjection } from "./projection.ts";
import { RemoteCatalog } from "./remote.ts";
import { restoredCatalog } from "./restore.ts";
import type { DevinModel, ModelCatalogShape } from "./types.ts";

const FRESHNESS_MS = 5 * 60_000;

/**
 * The only owner of the catalog query: when to look it up, what to restore from Pi's model store, and the list Pi shows.
 * State changes only inside a publication Pi accepted, so a cancelled or rejected refresh never changes the list.
 */
export class ModelCatalog extends Context.Service<ModelCatalog, ModelCatalogShape>()("pi-devin/ModelCatalog") {}

const publish = (context: RefreshModelsContext, publication: ModelsPublication) =>
  Effect.tryPromise({ try: () => context.publish(publication), catch: toDevinFailure });

export const ModelCatalogLive = Layer.effect(ModelCatalog, Effect.gen(function* () {
  const config = yield* ExtensionConfig;
  const auth = yield* AuthState;
  const guard = yield* CredentialGuard;
  const accounts = yield* Accounts;
  const remote = yield* RemoteCatalog;
  const fusionSettings = yield* FusionSettings;
  const displaySettings = yield* DisplaySettings;
  const changes = yield* UsageChanges;
  const lifetime = yield* ProviderLifetime;
  const now = config.now;

  // The stored list is shared by every Pi process that uses the lead's agent directory. Only the default list is stored,
  // without display filters or the sidekick-only exact list. It still holds every catalog config, so each process rebuilds its own list after restore.
  const build = (next: VariantProjection, credential: Credential, account: string | undefined, isForStorage = false) => Effect.gen(function* () {
    const fusion = config.isFusionChild ? false : yield* fusionSettings.read;
    const recommendedOnly = !isForStorage && !config.isFusionChild && (yield* displaySettings.read).recommendedOnly;
    return modelsFromProjection(next, credential, { fusion, recommendedOnly, listsAllExactModels: !isForStorage && config.isFusionChild, account });
  });
  let models: DevinModel[] = [], projection: VariantProjection | undefined, scope: string | undefined, catalogAccount: string | undefined;
  let checkedAtMs = 0, endpointOverride: string | undefined, modelCredential: Credential | undefined, credentialScope: string | undefined;
  const clear = () => {
    models = []; projection = undefined; scope = undefined; catalogAccount = undefined; checkedAtMs = 0; modelCredential = undefined; credentialScope = undefined;
  };
  const currentProjection = (credential: Credential) => !projection || scope !== catalogScope(credential)
    ? failWith("No Devin model list matches the current account and endpoint. Refresh the model list.") : Effect.succeed(projection);
  const fromHost = (credential: HostCredential | undefined) => credential?.type === "oauth" ? auth.fromHost(credential) : Effect.succeed(undefined);
  const effectiveCredential = (credential: HostCredential | undefined, baseUrl?: string) => Effect.flatMap(fromHost(credential), (resolved) => resolved
    ? Effect.map(endpoint(baseUrl ?? resolved.apiServerURL), (apiServerURL): Credential | undefined => ({ ...resolved, apiServerURL })) : Effect.succeed(undefined));
  const accountOf = (credential: Credential) => Effect.map(accounts.get(credential), (record) => record?.ownerHash);

  /** Only a confirmed 401 of the same sign-in generation invalidates the credential. */
  const fetchCatalog = (credential: Credential) => Effect.gen(function* () {
    const generation = yield* auth.generation;
    yield* auth.assertUsable(credential);
    return yield* remote.fetch(credential).pipe(Effect.tapError((error) => guard.reportFailure(credential, error, generation)));
  });

  const refresh = (context: RefreshModelsContext) => Effect.gen(function* () {
    const credential = yield* effectiveCredential(context.credential, context.baseUrl);
    if (!credential) {
      yield* publish(context, { update: clear });
      return;
    }
    const expectedScope = catalogScope(credential);
    // A bad cache is never used as run data, whatever is wrong with it. The current good state is kept.
    const restored = yield* restoredCatalog(context.stored, credential, yield* accountOf(credential)).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    if (restored && (scope !== expectedScope || !projection || (context.stored?.checkedAt ?? 0) > checkedAtMs)) {
      const { projection: restoredProjection, account: restoredAccount, isSameSession } = restored;
      const restoredModels = yield* build(restoredProjection, credential, restoredAccount);
      const checkedAt = context.stored?.checkedAt;
      const restoredAtMs = typeof checkedAt === "number" && Number.isFinite(checkedAt) && checkedAt >= 0 && checkedAt <= now() ? checkedAt : 0;
      const accepted = yield* publish(context, {
        // A catalog reused for a new session of the same account is stored under the new session, so a restart restores it too.
        ...(isSameSession ? {} : { persist: { models: yield* build(restoredProjection, credential, restoredAccount, true), checkedAt: restoredAtMs } }),
        update: () => {
          projection = restoredProjection; models = restoredModels; scope = expectedScope; catalogAccount = restoredAccount; modelCredential = credential;
          checkedAtMs = restoredAtMs; endpointOverride = context.baseUrl; credentialScope = expectedScope;
        },
      });
      if (!accepted) return;
    } else if (scope !== expectedScope || endpointOverride !== context.baseUrl || credentialScope !== expectedScope) {
      const accepted = yield* publish(context, { update: () => {
        if (scope !== expectedScope || endpointOverride !== context.baseUrl) clear();
        endpointOverride = context.baseUrl; credentialScope = expectedScope;
      } });
      if (!accepted) return;
    }
    if (!context.allowNetwork) return;
    const ageMs = now() - checkedAtMs;
    if (!context.force && scope === expectedScope && projection && checkedAtMs > 0 && ageMs >= 0 && ageMs < FRESHNESS_MS) return;
    const catalog = yield* fetchCatalog(credential);
    const nextProjection = yield* projectModelVariants(catalog);
    // Known after an account check in this process, or carried over from this same session's catalog.
    const nextAccount = (yield* accountOf(credential)) ?? (scope === expectedScope ? catalogAccount : undefined);
    const nextModels = yield* build(nextProjection, credential, nextAccount);
    const checkedAt = now();
    if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) return yield* failWith("Invalid model cache check time.");
    yield* publish(context, {
      persist: { models: yield* build(nextProjection, credential, nextAccount, true), checkedAt },
      update: () => {
        projection = nextProjection; models = nextModels; scope = expectedScope; catalogAccount = nextAccount; modelCredential = credential;
        checkedAtMs = checkedAt; endpointOverride = context.baseUrl; credentialScope = expectedScope;
      },
    });
  });

  return {
    models: Effect.sync(() => models),
    unsupported: Effect.sync(() => projection?.unsupported ?? []),
    exactLevel: (uid) => Effect.sync(() => projection?.variants.find((variant) => variant.model.id === uid && isUsable(variant))?.level),
    fusionChoices: Effect.sync(() => projection && !config.isFusionChild ? fusionChoices(projection) : undefined),
    rebuild: Effect.suspend(() => projection && modelCredential
      ? Effect.map(build(projection, modelCredential, catalogAccount), (next) => { models = next; }) : Effect.void),
    currentScope: Effect.sync(() => credentialScope),
    invalidate: Effect.sync(clear),
    filter: (candidates, credential) => Effect.map(effectiveCredential(credential, endpointOverride), (resolved) => {
      if (!resolved) return [];
      const expected = catalogScope(resolved);
      return candidates.filter((model) => model.provider === "devin" && model.api === DEVIN_API && model.baseUrl === resolved.apiServerURL && (model as DevinModel).devin?.scope === expected);
    }).pipe(Effect.catchCause(() => Effect.succeed([]))),
    // Sign-in, logout and restores change the current credential, which decides whose quota is shown.
    refresh: (context) => Effect.flatMap(lifetime.current, (current) => current.guard(refresh(context)).pipe(abortWith(context.signal), Effect.ensuring(changes.publish))),
    resolve: (modelID, level, credential) => Effect.gen(function* () {
      const current = yield* currentProjection(credential);
      let wanted = modelID;
      if (isFusionModelID(modelID)) {
        // Fusion lead requests use the same UID and thinking level as the selected lead group.
        const fusion = models.find((model) => model.id === modelID)?.devin.fusion;
        if (!fusion) return yield* failWith(`Fusion model unavailable: ${modelID}`);
        wanted = fusion.leadID;
      }
      const target = publicModelIDs(current).targets.get(wanted);
      if (!target) return yield* failWith(`Model or thinking level unavailable: ${modelID} (${level})`);
      return yield* resolveBackendSelection(current, "group" in target ? target.group.id : modelIDForUID(target.variant.model.id), level);
    }),
    resolveUID: (uid, credential) => Effect.gen(function* () {
      const current = yield* currentProjection(credential);
      const level = current.variants.find((variant) => variant.model.id === uid && isUsable(variant))?.level;
      if (!level) return yield* failWith(`Model UID unavailable: ${uid}`);
      return yield* resolveBackendSelection(current, modelIDForUID(uid), level);
    }),
  } satisfies ModelCatalogShape;
}));
