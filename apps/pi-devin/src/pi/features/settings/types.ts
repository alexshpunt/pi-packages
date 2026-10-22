import type { Effect } from "effect";
import type { DevinError } from "../../../core/errors.ts";
import type { FusionSelection } from "../catalog/types.ts";
import type { AccountUsage } from "../usage/types.ts";

/** Display settings toggled by `/devin`. Both default to off and never change how models are used or requested. */
export interface DevinPreferences {
  /** Lists only the models that have a variant the catalog marks as recommended. */
  recommendedOnly: boolean;
  /** Shows quota and session usage in the TUI status line. */
  showUsageStatus: boolean;
}

/** Global store for the lead and sidekick chosen with `/devin-fusion`. Every session uses the same value. */
export interface FusionSettingsShape {
  /** Never fails: a missing or unreadable store reads as no saved pair. */
  readonly read: Effect.Effect<FusionSelection | undefined>;
  write(selection: FusionSelection): Effect.Effect<void, DevinError>;
}

export interface DisplaySettingsShape {
  /** Never fails: a missing or unreadable store reads as the defaults. */
  readonly read: Effect.Effect<DevinPreferences>;
  write(preferences: DevinPreferences): Effect.Effect<void, DevinError>;
}

/**
 * Last account quota received by any Pi process that shares the agent directory, such as subagents and the Fusion sidekick.
 * Keyed by the credential scope hash. No token, account ID or raw response is stored.
 */
export interface UsageStoreShape {
  /** Never fails: a missing or unreadable record reads as none. */
  read(scope: string): Effect.Effect<AccountUsage | undefined>;
  /** Replaces the record unless the stored one for the same scope was fetched later. */
  write(scope: string, usage: AccountUsage): Effect.Effect<void, DevinError>;
}
