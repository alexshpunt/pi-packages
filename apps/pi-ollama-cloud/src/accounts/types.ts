import type { UsageData } from "../usage/api.ts";

/** Account ID reserved for the credential Pi resolves for the `ollama-cloud` provider. */
export const DEFAULT_ACCOUNT_ID = "default";

/** A resolved account. `apiKey` is kept in memory only and never written to state or logs. */
export interface OllamaAccount {
  id: string;
  apiKey: string;
  /** Non-secret identifier derived from the API key; keys the shared health state. */
  fingerprint: string;
  source: "pi" | "accounts-file";
}

export type UsageLimitWindow = "session" | "weekly" | "monthly" | "unknown";

export interface BalanceSnapshot {
  checkedAtMs: number;
  data: UsageData;
}

/** Shared, non-secret health of one credential. */
export interface AccountHealth {
  /** A usage limit was reached; the account is skipped until this time. */
  exhaustedUntilMs?: number;
  exhaustedWindow?: UsageLimitWindow;
  /** Ollama rejected the credential (HTTP 401); skipped until reset or until the key changes. */
  isUnauthorized?: boolean;
  /** Models rejected with HTTP 403 for this account, mapped to the time they may be retried. */
  blockedModels?: Record<string, number>;
  balance?: BalanceSnapshot;
  /** Last failed balance check; throttles retries and decides purchased-credit protection. */
  balanceFailedAtMs?: number;
  updatedAtMs: number;
}

/** Cross-process account state persisted next to Pi's agent files. Contains no secrets. */
export interface AccountState {
  version: 1;
  /** Round-robin cursor: the account most recently assigned to a new session. */
  lastAssignedAccountId?: string;
  disabledAccountIds: string[];
  /** Keyed by account fingerprint. */
  health: Record<string, AccountHealth>;
}

export type AccountFailure =
  | { kind: "usage-limit"; window: UsageLimitWindow }
  | { kind: "unauthorized" }
  | { kind: "forbidden" };
