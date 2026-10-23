import { Context, Effect, Layer } from "effect";
import { makeCancellation } from "../../../core/cancellation.ts";
import type { ProviderLifetimeShape } from "./types.ts";

/**
 * How long the provider's work may run: from a session attach until shutdown. Shutdown ends it with a reason
 * instead of interrupting fibers, so stopped requests report that reason. The next session attach starts a new one.
 */
export class ProviderLifetime extends Context.Service<ProviderLifetime, ProviderLifetimeShape>()("pi-devin/ProviderLifetime") {}

export const ProviderLifetimeLive = Layer.sync(ProviderLifetime, () => {
  let current = makeCancellation();
  return {
    current: Effect.sync(() => current),
    isActive: Effect.sync(() => !current.isCancelled()),
    end: (reason) => Effect.sync(() => current.cancelUnsafe(reason)),
    renew: Effect.sync(() => { if (current.isCancelled()) current = makeCancellation(); }),
  } satisfies ProviderLifetimeShape;
});
