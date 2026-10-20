import type { UsageData } from "../usage/api.ts";
import type { AccountHealth, AccountState, OllamaAccount, UsageLimitWindow } from "./types.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Probe delay when a usage-limit response does not come with a known reset time. */
export const FALLBACK_LIMIT_RETRY_MS: Readonly<Record<UsageLimitWindow, number>> = {
  session: 30 * MINUTE_MS,
  weekly: 6 * HOUR_MS,
  monthly: 24 * HOUR_MS,
  unknown: 30 * MINUTE_MS,
};
/** How long an account stays excluded for a model it was refused (HTTP 403). */
export const MODEL_BLOCK_MS = 6 * HOUR_MS;
/** Remaining included share at which accounts holding purchased credits stop being used. */
export const PURCHASE_RESERVE_FRACTION = 0.03;
/** Balance re-check interval for accounts without purchased credits, to notice newly bought credits. */
export const BALANCE_RECHECK_MS = 15 * MINUTE_MS;
/** Minimum delay before retrying a failed balance check. */
export const BALANCE_FAILURE_RETRY_MS = MINUTE_MS;
/** Oldest healthy snapshot trusted for an account with purchased credits while balance checks fail. */
const UNVERIFIED_PURCHASED_MAX_AGE_MS = 30 * MINUTE_MS;

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function resetCandidates(window: UsageLimitWindow, data: UsageData | undefined): (string | undefined)[] {
  const included = data?.included;
  if (!included) return [];
  if (window === "session") return [included.session?.resets_at];
  if (window === "weekly") return [included.weekly?.resets_at];
  if (window === "monthly") return [included.monthly?.resets_at, included.period?.until];
  return [included.session?.resets_at, included.weekly?.resets_at, included.monthly?.resets_at, included.period?.until];
}

/** Earliest future reset reported for the window, if the balance response provides one. */
export function limitResetAt(window: UsageLimitWindow, nowMs: number, data?: UsageData): number | undefined {
  const times = resetCandidates(window, data)
    .map(parseTime)
    .filter((time): time is number => time !== undefined && time > nowMs);
  return times.length > 0 ? Math.min(...times) : undefined;
}

export function exhaustedUntil(window: UsageLimitWindow, nowMs: number, data?: UsageData): number {
  return limitResetAt(window, nowMs, data) ?? nowMs + FALLBACK_LIMIT_RETRY_MS[window];
}

export function purchasedBalanceUsd(data: UsageData): number {
  const balance = data.purchased?.balance_usd;
  return typeof balance === "number" && Number.isFinite(balance) ? balance : 0;
}

/**
 * Remaining share of included usage, from quota windows (legacy plans) or the
 * included dollar allowance (credit plans). Missing included usage counts as none.
 */
export function includedRemainingFraction(data: UsageData): number {
  const included = data.included;
  if (!included) return 0;
  const remaining = [included.session, included.weekly, included.monthly]
    .map((window) => window?.remaining_percent)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (remaining.length > 0) return Math.min(Math.max(Math.min(...remaining) / 100, 0), 1);
  if (
    typeof included.balance_usd === "number" &&
    typeof included.allowance_usd === "number" &&
    included.allowance_usd > 0
  ) {
    return Math.min(Math.max(included.balance_usd / included.allowance_usd, 0), 1);
  }
  return 0;
}

export type PurchaseGuardDecision =
  | { action: "allow"; isUnverified?: boolean }
  | { action: "refresh" }
  | { action: "block"; reason: string };

function snapshotMaxAgeMs(fraction: number, isNearlyUsed: boolean): number {
  if (isNearlyUsed) return 5 * MINUTE_MS;
  if (fraction >= 0.25) return 10 * MINUTE_MS;
  if (fraction >= 0.1) return 2 * MINUTE_MS;
  return 30_000;
}

/**
 * Decide whether a request may spend this account's usage without drawing on
 * purchased credits. Ollama consumes included credits first and then purchased
 * credits without returning a limit error, so accounts holding purchased credits
 * are stopped before their included usage runs out. An account whose balance
 * was never verified is allowed (marked unverified) because a failing balance
 * endpoint must not disable every request.
 */
export function evaluatePurchaseGuard(health: AccountHealth | undefined, nowMs: number): PurchaseGuardDecision {
  const hasFailedRecently =
    health?.balanceFailedAtMs !== undefined && nowMs - health.balanceFailedAtMs < BALANCE_FAILURE_RETRY_MS;
  const snapshot = health?.balance;
  if (!snapshot) return hasFailedRecently ? { action: "allow", isUnverified: true } : { action: "refresh" };

  const ageMs = nowMs - snapshot.checkedAtMs;
  if (purchasedBalanceUsd(snapshot.data) <= 0) {
    return ageMs >= BALANCE_RECHECK_MS && !hasFailedRecently ? { action: "refresh" } : { action: "allow" };
  }

  const fraction = includedRemainingFraction(snapshot.data);
  const isNearlyUsed = fraction <= PURCHASE_RESERVE_FRACTION;
  const resetAt = limitResetAt("unknown", snapshot.checkedAtMs, snapshot.data);
  const isStale = ageMs >= snapshotMaxAgeMs(fraction, isNearlyUsed) || (resetAt !== undefined && nowMs >= resetAt);
  if (isStale && !hasFailedRecently) return { action: "refresh" };
  if (isNearlyUsed) {
    return { action: "block", reason: "included usage nearly used; purchased credits are protected" };
  }
  if (isStale && (fraction < 0.1 || ageMs >= UNVERIFIED_PURCHASED_MAX_AGE_MS)) {
    return { action: "block", reason: "purchased credits present and the balance could not be verified" };
  }
  return { action: "allow" };
}

export function formatResetTime(timeMs: number): string {
  return `${new Date(timeMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function healthOf(state: AccountState, account: OllamaAccount): AccountHealth | undefined {
  return Object.hasOwn(state.health, account.fingerprint) ? state.health[account.fingerprint] : undefined;
}

function blockedUntil(health: AccountHealth | undefined, modelId: string | undefined): number | undefined {
  if (!modelId || !health?.blockedModels || !Object.hasOwn(health.blockedModels, modelId)) return undefined;
  return health.blockedModels[modelId];
}

/** Why an account cannot serve a request now, or undefined when it can (possibly after a balance refresh). */
export function accountUnavailableReason(
  account: OllamaAccount,
  state: AccountState,
  nowMs: number,
  modelId?: string,
): string | undefined {
  if (state.disabledAccountIds.includes(account.id)) return "disabled";
  const health = healthOf(state, account);
  if (health?.isUnauthorized) return "API key rejected";
  if (health?.exhaustedUntilMs !== undefined && health.exhaustedUntilMs > nowMs) {
    const window = health.exhaustedWindow && health.exhaustedWindow !== "unknown" ? `${health.exhaustedWindow} ` : "";
    return `${window}usage limit reached until ${formatResetTime(health.exhaustedUntilMs)}`;
  }
  const modelBlockedUntil = blockedUntil(health, modelId);
  if (modelBlockedUntil !== undefined && modelBlockedUntil > nowMs) return `model ${modelId} not permitted`;
  const guard = evaluatePurchaseGuard(health, nowMs);
  return guard.action === "block" ? guard.reason : undefined;
}

export interface AccountChoiceInput {
  /** Rotation order: the Pi credential first, then the accounts file order. */
  accounts: readonly OllamaAccount[];
  state: AccountState;
  boundAccountId?: string;
  excludedIds?: ReadonlySet<string>;
  modelId?: string;
  nowMs: number;
}

export interface AccountChoice {
  account: OllamaAccount;
  /** False when the session keeps its bound account; true for a round-robin assignment. */
  isNewAssignment: boolean;
}

/**
 * Keep the session's bound account while it is usable; otherwise assign the next
 * usable account after the shared round-robin cursor.
 */
export function chooseAccount(input: AccountChoiceInput): AccountChoice | undefined {
  const { accounts, state, boundAccountId, excludedIds, modelId, nowMs } = input;
  const candidates = accounts.filter(
    (account) =>
      !excludedIds?.has(account.id) && accountUnavailableReason(account, state, nowMs, modelId) === undefined,
  );
  if (candidates.length === 0) return undefined;
  const bound = candidates.find((account) => account.id === boundAccountId);
  if (bound) return { account: bound, isNewAssignment: false };
  const start = accounts.findIndex((account) => account.id === state.lastAssignedAccountId);
  for (let offset = 1; offset <= accounts.length; offset++) {
    const account = accounts[(start + offset + accounts.length) % accounts.length];
    if (candidates.includes(account)) return { account, isNewAssignment: true };
  }
  return { account: candidates[0], isNewAssignment: true };
}
