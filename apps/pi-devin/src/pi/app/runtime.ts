import { Layer, ManagedRuntime } from "effect";
import type { DevinError } from "../../core/errors.ts";
import type { SidekickHost } from "../features/sidekick/service.ts";
import { ExtensionLive, ProviderLive, type ExtensionEnvironment, type ProviderEnvironment } from "./layer.ts";

export type ProviderServices = Layer.Success<typeof ProviderLive> | ProviderEnvironment;
export type ExtensionServices = Layer.Success<typeof ExtensionLive> | ExtensionEnvironment | SidekickHost;
export type ProviderRuntime = ManagedRuntime.ManagedRuntime<ProviderServices, DevinError>;
export type ExtensionRuntime = ManagedRuntime.ManagedRuntime<ExtensionServices, DevinError>;

/**
 * One runtime per extension instance. It is never disposed on `session_shutdown`: Pi may still call the same provider
 * afterwards, and the next `session_start` reuses it with a new provider lifetime. Its layers hold no operating system
 * resources; connection pools close with their clients and sidekick children with their sessions.
 */
export const makeProviderRuntime = (environment: Layer.Layer<ProviderEnvironment>): ProviderRuntime =>
  ManagedRuntime.make(ProviderLive.pipe(Layer.provideMerge(environment)));

export const makeExtensionRuntime = (environment: Layer.Layer<ExtensionEnvironment>, host: Layer.Layer<SidekickHost>): ExtensionRuntime =>
  ManagedRuntime.make(ExtensionLive.pipe(Layer.provideMerge(Layer.mergeAll(environment, host))));
