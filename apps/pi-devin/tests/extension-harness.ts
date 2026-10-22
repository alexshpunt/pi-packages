import { spawn } from "node:child_process";
import type { Credential as HostCredential } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime, Scope } from "effect";
import type { DevinError, DevinFailure } from "../src/core/errors.ts";
import type { ModelCatalog as Catalog } from "../src/core/models/catalog.ts";
import type { DeviceIdentity } from "../src/core/protocol/device.ts";
import type { Credential } from "../src/core/types.ts";
import { DeviceIdentitySource } from "../src/core/services/device-identity.ts";
import { HttpTransport, type HttpTransportShape } from "../src/core/services/http-transport.ts";
import { NodePlatformLayer } from "../src/core/services/platform.ts";
import { registerDevinExtension } from "../src/pi/adapters/pi/registration.ts";
import { makeDevinProvider } from "../src/pi/adapters/pi/provider.ts";
import type { DevinProvider } from "../src/pi/adapters/pi/types.ts";
import { currentAccountUsage, UsageStatus, type UsageStatusShape } from "../src/pi/adapters/pi/usage-status.ts";
import { ExtensionConfig, type LoginSettings } from "../src/pi/app/config.ts";
import type { ExtensionEnvironment } from "../src/pi/app/layer.ts";
import { makeProviderRuntime, type ExtensionRuntime, type ProviderRuntime } from "../src/pi/app/runtime.ts";
import { shutdownProvider } from "../src/pi/app/session.ts";
import { PiSidekickHost, sidekickTool } from "../src/pi/adapters/pi/sidekick-tool.ts";
import { Accounts } from "../src/pi/features/accounts/service.ts";
import type { AccountsShape } from "../src/pi/features/accounts/types.ts";
import { CredentialGuard } from "../src/pi/features/auth/guard.ts";
import { AuthState } from "../src/pi/features/auth/state.ts";
import type { AuthStateShape } from "../src/pi/features/auth/types.ts";
import { RemoteCatalog } from "../src/pi/features/catalog/remote.ts";
import { LoginTransport } from "../src/pi/features/auth/login.ts";
import { ModelCatalog, ModelCatalogLive } from "../src/pi/features/catalog/service.ts";
import type { DevinModel, FusionChoices, FusionSelection, ModelCatalogShape } from "../src/pi/features/catalog/types.ts";
import { ProviderLifetimeLive } from "../src/pi/features/lifetime/service.ts";
import type { DevinLifecycle } from "../src/pi/features/runs/lifecycle.ts";
import { Runs } from "../src/pi/features/runs/service.ts";
import { DisplaySettings, FusionSettings, memoryDisplaySettings, memoryFusionSettings, memoryUsageStore, UsageStore } from "../src/pi/features/settings/service.ts";
import type { DisplaySettingsShape, FusionSettingsShape, UsageStoreShape } from "../src/pi/features/settings/types.ts";
import { PACKAGE_ROOT, resolvePiCommand } from "../src/pi/features/sidekick/command.ts";
import { SidekickLauncher } from "../src/pi/features/sidekick/launcher.ts";
import { Sidekicks, SidekicksLive } from "../src/pi/features/sidekick/service.ts";
import type { SidekickLauncherShape } from "../src/pi/features/sidekick/types.ts";
import { UsageChanges, UsageChangesLive } from "../src/pi/features/usage/changes.ts";
import type { AccountUsage } from "../src/pi/features/usage/types.ts";
import { identity, transportOf, type TransportChoice } from "./helpers.ts";

/** What a test controls about the extension's environment. Everything else is the production composition. */
export interface TestOptions extends TransportChoice {
  /** Replaces the provider's transport outright, for example to count connection pools. */
  transport?: HttpTransportShape;
  maxModelCalls?: number;
  /** `/login` endpoints, and a fetch for its code exchanges; without one, sign-in uses the provider's transport choice. */
  loginOptions?: LoginSettings & { fetch?: typeof fetch };
  /** Device values for request fingerprints. Defaults to fixed offline values. */
  deviceIdentity?: Effect.Effect<DeviceIdentity>;
  accountUsage?: UsageStoreShape;
  now?: () => number;
  fusionSettings?: FusionSettingsShape;
  devinSettings?: DisplaySettingsShape;
  isFusionChild?: boolean;
  sidekick?: { agentDir?: () => string; launcher?: Partial<SidekickLauncherShape> };
  /** Listens to quota and credential changes, as the status line does. */
  onAccountUsage?: () => Effect.Effect<void>;
}

/** The extension's environment from test options: injected transports, fixed device values, memory stores and an optional fake launcher. */
export function testEnvironment(options: TestOptions = {}): Layer.Layer<ExtensionEnvironment> {
  const { fetch: loginFetch, ...login } = options.loginOptions ?? {};
  return Layer.mergeAll(
    Layer.succeed(ExtensionConfig, {
      maxModelCalls: options.maxModelCalls, now: options.now ?? Date.now, isFusionChild: options.isFusionChild === true, login,
      agentDir: options.sidekick?.agentDir ?? (() => "/unused-agent-dir"),
    }),
    Layer.succeed(HttpTransport, options.transport ?? transportOf(options)),
    Layer.succeed(LoginTransport, loginFetch ? transportOf({ fetch: loginFetch }) : options.transport ?? transportOf(options)),
    Layer.succeed(DeviceIdentitySource, { collect: options.deviceIdentity ?? Effect.succeed(identity) }),
    Layer.succeed(FusionSettings, options.fusionSettings ?? memoryFusionSettings()),
    Layer.succeed(DisplaySettings, options.devinSettings ?? memoryDisplaySettings()),
    Layer.succeed(UsageStore, options.accountUsage ?? memoryUsageStore()),
    Layer.succeed(SidekickLauncher, { resolveCommand: resolvePiCommand, spawn, env: process.env, packageRoot: PACKAGE_ROOT, ...options.sidekick?.launcher }),
    NodePlatformLayer,
  );
}

/** Test access to a provider and the services behind it. */
export interface TestProvider {
  provider: DevinProvider;
  runtime: ProviderRuntime;
  /** The run service, as Pi's lifecycle events drive it. */
  runs: DevinLifecycle;
  shutdown(): void;
  /** Newest quota for the current credential, as `/devin` and the status line read it. */
  accountUsage(): AccountUsage | undefined;
  fusionChoices(): FusionChoices | undefined;
  models(): readonly DevinModel[];
}

function testAccess(provider: DevinProvider, runtime: ProviderRuntime): TestProvider {
  const catalog = runtime.runSync(ModelCatalog), accounts = runtime.runSync(Accounts);
  return {
    provider, runtime, runs: runtime.runSync(Runs),
    shutdown: () => runtime.runSync(shutdownProvider),
    accountUsage: () => runtime.runSync(currentAccountUsage(catalog, accounts)),
    fusionChoices: () => runtime.runSync(catalog.fusionChoices),
    models: () => runtime.runSync(catalog.models),
  };
}

/** Subscribes a listener for the rest of the runtime's life. */
function listen(runtime: ProviderRuntime, listener: (() => Effect.Effect<void>) | undefined): void {
  if (!listener) return;
  const scope = runtime.runSync(Scope.make());
  runtime.runSync(Effect.flatMap(UsageChanges, (changes) => changes.subscribe(Effect.suspend(listener))).pipe(Scope.provide(scope)));
}

/** The provider alone, as Pi's SDK would register it, on test services. */
export function makeTestProvider(options: TestOptions = {}): TestProvider {
  const runtime = makeProviderRuntime(testEnvironment(options));
  const provider = makeDevinProvider(runtime);
  listen(runtime, options.onAccountUsage);
  return testAccess(provider, runtime);
}

/** The whole extension on test services, registered with the given Pi API. */
export function registerTestExtension(pi: ExtensionAPI, options: TestOptions = {}): TestProvider & { runtime: ExtensionRuntime; usageStatus: UsageStatusShape } {
  const { provider, runtime } = registerDevinExtension(pi, testEnvironment(options));
  listen(runtime, options.onAccountUsage);
  return { ...testAccess(provider, runtime), runtime, usageStatus: runtime.runSync(UsageStatus) };
}

/** A transport over a test fetch that counts the connection pools clients open and close. */
export function countingTransport(fetchImpl: typeof fetch, onClose: () => void): HttpTransportShape {
  const base = transportOf({ fetch: fetchImpl });
  return { open: Effect.tap(base.open, () => Effect.addFinalizer(() => Effect.sync(onClose))) };
}

/** What a catalog unit test supplies in place of the services around the catalog owner. */
export interface TestCatalogOptions {
  credentialFromHost: (value: HostCredential | undefined) => Effect.Effect<Credential | undefined, DevinError>;
  fetchCatalog: (credential: Credential) => Effect.Effect<Catalog, DevinFailure>;
  now?: () => number;
  /** false builds the sidekick child's list. */
  fusion?: false | Effect.Effect<FusionSelection | undefined>;
  recommendedOnly?: Effect.Effect<boolean>;
  listsAllExactModels?: boolean;
  /** Account identity hash this process verified for a credential. */
  accountOf?: (credential: Credential) => string | undefined;
}

/**
 * The production catalog owner with its neighbors replaced: credential conversion, the remote lookup and verified accounts
 * come from the test, as the catalog sees them through their service contracts.
 */
export function makeTestCatalog(options: TestCatalogOptions): ModelCatalogShape {
  const isFusionChild = options.fusion === false || options.listsAllExactModels === true;
  const unused = () => Effect.die("Not used by the catalog.");
  const auth: AuthStateShape = {
    generation: Effect.succeed(0), assertUsable: () => Effect.void, assertOAuthSession: () => Effect.void, rememberOAuth: Effect.succeed,
    // A test conversion may find no credential; the catalog then treats Pi as signed out, as it does for a non-OAuth credential.
    fromHost: (value) => options.credentialFromHost(value) as Effect.Effect<Credential, DevinError>,
    markInvalid: () => Effect.succeed(false), acceptLogin: () => Effect.succeed(1),
  };
  const accounts: AccountsShape = {
    get: (credential) => Effect.sync(() => { const ownerHash = options.accountOf?.(credential); return ownerHash ? { ownerHash, status: {} } : undefined; }),
    check: unused, forget: () => Effect.void, clear: Effect.void, usage: () => Effect.succeed(undefined),
  };
  const fusion = options.fusion === false || options.fusion === undefined ? Effect.succeed(undefined) : options.fusion;
  const layer = ModelCatalogLive.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(ExtensionConfig, { now: options.now ?? Date.now, isFusionChild, login: {}, agentDir: () => "/unused-agent-dir" }),
    Layer.succeed(AuthState, auth),
    Layer.succeed(CredentialGuard, { reportFailure: () => Effect.void }),
    Layer.succeed(Accounts, accounts),
    Layer.succeed(RemoteCatalog, { fetch: options.fetchCatalog }),
    Layer.succeed(FusionSettings, { read: fusion, write: unused }),
    Layer.succeed(DisplaySettings, { read: Effect.map(options.recommendedOnly ?? Effect.succeed(false), (recommendedOnly) => ({ recommendedOnly, showUsageStatus: false })), write: unused }),
    UsageChangesLive, ProviderLifetimeLive,
  )));
  return Effect.runSync(Effect.provide(Effect.gen(function* () { return yield* ModelCatalog; }), layer));
}

/** What the sidekick tool reads from the lead's catalog. */
export interface TestSidekickCatalog {
  models: readonly DevinModel[];
  fusionChoices: FusionChoices | undefined;
}

/**
 * The production sidekick service and tool adapter over a fixed catalog, the given lead Pi and a fake launcher.
 * The layer is built before this returns, so everything the service allocates exists by then.
 */
export function makeTestSidekickTool(pi: ExtensionAPI, catalog: TestSidekickCatalog, launcher: Partial<SidekickLauncherShape>) {
  const unused = () => Effect.die("Not used by the sidekick.");
  const catalogService: ModelCatalogShape = {
    models: Effect.sync(() => catalog.models), fusionChoices: Effect.sync(() => catalog.fusionChoices),
    filter: unused, refresh: unused, resolve: unused, resolveUID: unused, unsupported: unused(), exactLevel: unused,
    rebuild: unused(), currentScope: unused(), invalidate: unused(),
  };
  const runtime = ManagedRuntime.make(SidekicksLive.pipe(Layer.provide(Layer.mergeAll(
    PiSidekickHost(pi),
    Layer.succeed(ModelCatalog, catalogService),
    Layer.succeed(ExtensionConfig, { now: Date.now, isFusionChild: false, login: {}, agentDir: () => "/unused-agent-dir" }),
    Layer.succeed(SidekickLauncher, { resolveCommand: resolvePiCommand, spawn, env: process.env, packageRoot: PACKAGE_ROOT, ...launcher }),
    NodePlatformLayer,
  ))));
  const definition = sidekickTool(runtime), sidekicks = runtime.runSync(Sidekicks);
  return {
    definition,
    /** Session end, as `session_shutdown` resets the sidekicks. */
    reset: () => runtime.runSync(sidekicks.reset),
    /** A user message, as Pi's `input` event reports it. */
    onInput: (source: "interactive" | "rpc" | "extension") => runtime.runSync(sidekicks.userInput(source)),
  };
}
