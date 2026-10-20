import { formatUsageSummary } from "../usage/api.ts";
import { accountUnavailableReason, evaluatePurchaseGuard, healthOf } from "./policy.ts";
import type { AccountProblem } from "./router.ts";
import type { AccountState, OllamaAccount } from "./types.ts";

/** Number of leading API-key characters shown in account lists and while typing a key. */
export const VISIBLE_KEY_PREFIX_LENGTH = 6;

/** The first characters of a key, enough to recognize it without revealing it. */
export function keyPrefix(apiKey: string): string {
  return `${apiKey.slice(0, VISIBLE_KEY_PREFIX_LENGTH)}…`;
}

/** Availability label for one account, e.g. `available` or the reason it is skipped. */
export function accountStatusLabel(account: OllamaAccount, state: AccountState, nowMs: number): string {
  const reason = accountUnavailableReason(account, state, nowMs);
  if (reason) return reason;
  const guard = evaluatePurchaseGuard(healthOf(state, account), nowMs);
  return guard.action === "allow" && guard.isUnverified ? "available (balance not verified)" : "available";
}

function ageLabel(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

export interface AccountOverview {
  id: string;
  source: OllamaAccount["source"];
  keyPrefix: string;
  status: string;
  isAvailable: boolean;
  isDisabled: boolean;
  /** Last known balance summary, or undefined before the first balance check. */
  usage: string | undefined;
  /** When the usage summary was recorded, e.g. `3 min ago`. */
  checked: string | undefined;
}

export function accountOverview(account: OllamaAccount, state: AccountState, nowMs: number): AccountOverview {
  const balance = healthOf(state, account)?.balance;
  const summary = balance ? formatUsageSummary(balance.data) : undefined;
  return {
    id: account.id,
    source: account.source,
    keyPrefix: keyPrefix(account.apiKey),
    status: accountStatusLabel(account, state, nowMs),
    isAvailable: accountUnavailableReason(account, state, nowMs) === undefined,
    isDisabled: state.disabledAccountIds.includes(account.id),
    usage: summary || (balance ? "no usage data" : undefined),
    checked: balance ? ageLabel(nowMs - balance.checkedAtMs) : undefined,
  };
}

export interface AccountsReportInput {
  accounts: readonly OllamaAccount[];
  problems: readonly AccountProblem[];
  state: AccountState;
  boundAccountId: string | undefined;
  nowMs: number;
  accountsPath: string;
}

/** Plain-text account list for modes without the settings panel. */
export function formatAccountsReport(input: AccountsReportInput): string {
  const { accounts, problems, state, boundAccountId, nowMs, accountsPath } = input;
  const lines = [`Ollama Cloud accounts: ${accounts.length} usable, session-sticky round-robin`];
  for (const account of accounts) {
    const overview = accountOverview(account, state, nowMs);
    const marker = account.id === boundAccountId ? "*" : " ";
    const source = account.source === "pi" ? "Pi credential" : "accounts file";
    lines.push(`${marker} ${account.id} ${overview.keyPrefix} [${source}] ${overview.status}`);
    if (overview.usage) lines.push(`    ${overview.usage} (checked ${overview.checked})`);
  }
  for (const problem of problems) lines.push(`  ${problem.id} [accounts file] unusable: ${problem.error}`);
  if (accounts.length === 0 && problems.length === 0) {
    lines.push("  No accounts. Sign in with /login or set OLLAMA_API_KEY, then add more in /ollama.");
  }
  lines.push(`* marks this session's account. Additional accounts: ${accountsPath}`);
  return lines.join("\n");
}
