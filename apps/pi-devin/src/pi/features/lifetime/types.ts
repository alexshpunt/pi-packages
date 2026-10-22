import type { Effect } from "effect";
import type { Cancellation } from "../../../core/cancellation.ts";
import type { DevinFailure } from "../../../core/errors.ts";

export interface ProviderLifetimeShape {
  /** The lifetime current at the call. Work captures it when it starts, so a later session's lifetime never stops it. */
  readonly current: Effect.Effect<Cancellation>;
  readonly isActive: Effect.Effect<boolean>;
  /** Ends the current lifetime; work guarded by it fails with this reason. */
  readonly end: (reason: DevinFailure) => Effect.Effect<void>;
  /** Starts a new lifetime when the current one has ended. */
  readonly renew: Effect.Effect<void>;
}
