import type { Credential as HostCredential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { Effect } from "effect";
import type { DevinError, DevinFailure } from "../../../core/errors.ts";
import type { ModelCatalog as Catalog } from "../../../core/models/catalog.ts";
import type { BackendModelSelection, EffectiveThinkingLevel } from "../../../core/models/variants.ts";
import type { Credential, JsonObject } from "../../../core/types.ts";

/** The Pi model API this provider registers. Duplicated as a literal type so type modules stay free of runtime imports. */
export type DevinAPI = "devin-connect";

/** The lead is a published group model ID; the sidekick is an exact variant model ID. Both come from `publicModelIDs`. */
export interface FusionSelection { leadID: string; sidekickID: string }
export interface FusionChoices {
  leads: { id: string; name: string; recommended?: true }[];
  /** `level` is the thinking level of this UID. It is passed to the sidekick child Pi as is. */
  sidekicks: { id: string; name: string; groupName: string; level: EffectiveThinkingLevel; recommended?: true }[];
}

export interface DevinModel extends Model<DevinAPI> {
  devin: {
    version: number; scope: string; costsUnknown: true; configs: JsonObject[]; unavailable?: JsonObject[];
    fusion?: FusionSelection;
    /** Marked as recommended by the catalog. For a group, true when any variant is recommended. */
    recommended?: true;
    /** Account identity hash (endpoint and user ID) the catalog belongs to. Lets a new session of the same account reuse it. */
    account?: string;
  };
}

/** One remote catalog lookup for a credential, with the team's model policy applied. */
export interface RemoteCatalogShape {
  readonly fetch: (credential: Credential) => Effect.Effect<Catalog, DevinFailure>;
}

export interface ModelCatalogShape {
  /** The current Pi model list. Makes no request. */
  readonly models: Effect.Effect<readonly DevinModel[]>;
  /** The given Pi models that belong to the credential's catalog scope. Never fails. */
  readonly filter: (models: readonly Model<DevinAPI>[], credential: HostCredential | undefined) => Effect.Effect<readonly Model<DevinAPI>[]>;
  /** Restores or refreshes the list for Pi's current credential. Stops with the provider lifetime and Pi's signal. */
  readonly refresh: (context: RefreshModelsContext) => Effect.Effect<void, DevinFailure>;
  readonly resolve: (modelID: string, level: EffectiveThinkingLevel, credential: Credential) => Effect.Effect<BackendModelSelection, DevinError>;
  /** Resolves a catalog UID chosen by a payload hook at that variant's thinking level, including UIDs hidden from the list. */
  readonly resolveUID: (uid: string, credential: Credential) => Effect.Effect<BackendModelSelection, DevinError>;
  readonly unsupported: Effect.Effect<readonly { uid: string; reason: string }[]>;
  /** Thinking level of a usable exact UID in the current catalog, including hidden ones. */
  readonly exactLevel: (uid: string) => Effect.Effect<EffectiveThinkingLevel | undefined>;
  /** Fusion candidates of the current catalog. Undefined without a catalog or in the sidekick child. */
  readonly fusionChoices: Effect.Effect<FusionChoices | undefined>;
  /** Rebuilds the list from the current catalog without network after a saved choice or setting changes. */
  readonly rebuild: Effect.Effect<void>;
  /** Scope of the credential seen by the last refresh, even before its catalog loads. Undefined after logout or sign-in. */
  readonly currentScope: Effect.Effect<string | undefined>;
  /** Forgets the list, for example after a new sign-in. */
  readonly invalidate: Effect.Effect<void>;
}
