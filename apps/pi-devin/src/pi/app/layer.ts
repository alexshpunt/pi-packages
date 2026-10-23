import { Layer, type FileSystem } from "effect";
import type { DeviceIdentitySource } from "../../core/services/device-identity.ts";
import type { HttpTransport } from "../../core/services/http-transport.ts";
import { UsageStatusLive } from "../adapters/pi/usage-status.ts";
import { AccountsLive } from "../features/accounts/service.ts";
import { CredentialGuardLive } from "../features/auth/guard.ts";
import { AccountLoginLive, type LoginTransport } from "../features/auth/login.ts";
import { AuthStateLive } from "../features/auth/state.ts";
import { RemoteCatalogLive } from "../features/catalog/remote.ts";
import { ModelCatalogLive } from "../features/catalog/service.ts";
import { DevinClientsLive } from "../features/clients/service.ts";
import { InferenceLive } from "../features/inference/service.ts";
import { ProviderLifetimeLive } from "../features/lifetime/service.ts";
import { RunsLive } from "../features/runs/service.ts";
import type { DisplaySettings, FusionSettings, UsageStore } from "../features/settings/service.ts";
import type { SidekickLauncher } from "../features/sidekick/launcher.ts";
import { SidekicksLive } from "../features/sidekick/service.ts";
import { UsageChangesLive } from "../features/usage/changes.ts";
import type { ExtensionConfig } from "./config.ts";

/** What the entry point provides for the provider: its values and external I/O. */
export type ProviderEnvironment = ExtensionConfig | HttpTransport | LoginTransport | DeviceIdentitySource | FusionSettings | DisplaySettings | UsageStore;
/** The provider environment plus what the extension's host features need. */
export type ExtensionEnvironment = ProviderEnvironment | SidekickLauncher | FileSystem.FileSystem;

/** State owners that need no other feature. */
const StateLive = Layer.mergeAll(ProviderLifetimeLive, AuthStateLive, UsageChangesLive, RunsLive);

/**
 * Features behind Pi's provider contract. Each layer receives the ones below it, so dependencies only point downward:
 * requests and sign-in use the catalog, which uses the guard and accounts, which use clients and the state owners.
 */
export const ProviderLive = Layer.mergeAll(InferenceLive, AccountLoginLive).pipe(
  Layer.provideMerge(ModelCatalogLive),
  Layer.provideMerge(RemoteCatalogLive),
  Layer.provideMerge(CredentialGuardLive),
  Layer.provideMerge(AccountsLive),
  Layer.provideMerge(DevinClientsLive),
  Layer.provideMerge(StateLive),
);

/** The provider and the features that need Pi's host: the Fusion sidekick and the usage status line. */
export const ExtensionLive = Layer.mergeAll(SidekicksLive, UsageStatusLive).pipe(Layer.provideMerge(ProviderLive));
