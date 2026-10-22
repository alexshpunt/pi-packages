import type { ModelsStoreEntry } from "@earendil-works/pi-ai";
import { Effect, Predicate } from "effect";
import { restoreModelVariants, type VariantProjection } from "../../../core/models/variants.ts";
import type { Credential, JsonObject } from "../../../core/types.ts";
import { CATALOG_VERSION, DEVIN_API } from "./constants.ts";
import { catalogScope } from "./projection.ts";
import type { DevinModel } from "./types.ts";

const ACCOUNT_HASH = /^[a-f0-9]{64}$/;
export interface RestoredCatalog { projection: VariantProjection; account?: string; isSameSession: boolean }

/** Every stored entry's configs when the whole store belongs to one scope and one account; anything mixed or edited is ignored. */
function storedConfigs(stored: Readonly<ModelsStoreEntry>, credential: Credential): { configs: JsonObject[]; scope: unknown; account: unknown } | undefined {
  const configs = new Map<string, JsonObject>();
  let storedScope: unknown, storedAccount: unknown;
  for (const [index, model] of stored.models.entries()) {
    const metadata = (model as DevinModel).devin as unknown;
    if (!Predicate.isObject(metadata)) return undefined;
    if ((model.type !== undefined && model.type !== "chat") || model.provider !== "devin" || model.api !== DEVIN_API || model.baseUrl !== credential.apiServerURL
      || metadata.version !== CATALOG_VERSION || !Predicate.isString(metadata.scope)) return undefined;
    if (metadata.account !== undefined && (!Predicate.isString(metadata.account) || !ACCOUNT_HASH.test(metadata.account))) return undefined;
    if (index === 0) { storedScope = metadata.scope; storedAccount = metadata.account; }
    else if (metadata.scope !== storedScope || metadata.account !== storedAccount) return undefined;
    if (!Array.isArray(metadata.configs)) return undefined;
    for (const value of [...metadata.configs, ...(Array.isArray(metadata.unavailable) ? metadata.unavailable : [])]) {
      if (!Predicate.isObject(value) || !Predicate.isString(value.modelUid)) return undefined;
      const config = value as JsonObject;
      const previous = configs.get(value.modelUid);
      if (previous && JSON.stringify(previous) !== JSON.stringify(config)) return undefined;
      configs.set(value.modelUid, config);
    }
  }
  return { configs: [...configs.values()], scope: storedScope, account: storedAccount };
}

/**
 * Restores the stored catalog of the same session, or of an earlier session of an account this process verified for `account`.
 * Every entry must share one scope and one account, so a mixed or edited cache is never partly applied. A bad cache yields none.
 */
export function restoredCatalog(stored: Readonly<ModelsStoreEntry> | undefined, credential: Credential, account: string | undefined): Effect.Effect<RestoredCatalog | undefined> {
  return Effect.suspend(() => {
    if (!stored?.models.length) return Effect.succeed(undefined);
    const entries = storedConfigs(stored, credential);
    if (!entries) return Effect.succeed(undefined);
    const isSameSession = entries.scope === catalogScope(credential);
    // Another session's catalog is used only for the same verified account; account changes and logout never expose it.
    if (!isSameSession && (account === undefined || entries.account !== account)) return Effect.succeed(undefined);
    return restoreModelVariants(entries.configs).pipe(
      Effect.map((projection): RestoredCatalog | undefined => ({ projection, account: account ?? entries.account as string | undefined, isSameSession })),
      Effect.orElseSucceed(() => undefined),
    );
  });
}
