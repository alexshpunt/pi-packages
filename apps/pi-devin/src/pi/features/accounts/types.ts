import type { Effect } from "effect";
import type { DevinFailure } from "../../../core/errors.ts";
import type { Credential, JsonObject } from "../../../core/types.ts";
import type { AccountUsage } from "../usage/types.ts";

export interface AccountRecord { ownerHash: string; status: JsonObject }

export interface AccountCheck {
  /** Sign-in generation the caller started in. When a newer sign-in started meanwhile, nothing is recorded. */
  expectedGeneration: number;
  /** Connection settings of the lookup, such as Pi's per-request fetch and time limit. */
  connection?: { fetch?: typeof fetch; timeoutMs?: number };
  /** Runs after the generation check and before recording. Its failure leaves the result unrecorded. */
  beforeRecord?: Effect.Effect<void, DevinFailure>;
}

export interface AccountsShape {
  readonly get: (credential: Credential) => Effect.Effect<AccountRecord | undefined>;
  /** Looks up the account status and records it. `"stale"` when a newer sign-in started meanwhile. Failure policy belongs to the caller. */
  readonly check: (credential: Credential, check: AccountCheck) => Effect.Effect<"recorded" | "stale", DevinFailure>;
  readonly forget: (credential: Credential) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
  /** Newest quota for the scope, received here or by another process sharing the usage store. Makes no request. */
  readonly usage: (scope: string) => Effect.Effect<AccountUsage | undefined>;
}
