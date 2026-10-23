import type { Effect, Scope } from "effect";

/** Quota from the account status (`GetUserStatus`). Values may have changed since it was fetched. */
export interface AccountUsage {
  billingStrategy?: string;
  dailyRemainingPercent?: number;
  weeklyRemainingPercent?: number;
  dailyResetAtMs?: number;
  weeklyResetAtMs?: number;
  fetchedAtMs: number;
}

/** Totals of Devin assistant responses recorded in the current session branch. Sidekick child conversations are separate sessions and are not included. */
export interface SessionUsage {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Color level by remaining amount. Matches the Pi theme color names `success`, `warning` and `error`. */
export type UsageTone = "success" | "warning" | "error";
export interface UsageLine { text: string; isHeading?: boolean; tone?: UsageTone }
/** Colors a segment. The default returns it uncolored. */
export type UsagePainter = (tone: UsageTone, text: string) => string;

export interface UsageChangesShape {
  /** Tells every listener, in order, that the quota or the current credential may have changed. Listener failures never reach the caller. */
  readonly publish: Effect.Effect<void>;
  /** Listens until the scope closes. */
  readonly subscribe: (listener: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
}
