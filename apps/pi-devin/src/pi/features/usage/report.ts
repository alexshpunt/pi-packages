import type { JsonObject } from "../../../core/types.ts";
import type { BudgetUsage } from "../runs/types.ts";
import type { AccountUsage, SessionUsage, UsageLine, UsagePainter, UsageTone } from "./types.ts";

const plain: UsagePainter = (_tone, text) => text;

const QUOTA_STRATEGY = "BILLING_STRATEGY_QUOTA";

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

function unixToMs(value: unknown): number | undefined {
  const seconds = finiteNumber(value);
  return seconds !== undefined && seconds > 0 ? seconds * 1000 : undefined;
}

/** Reads only the fields that `DevinClient.status()` exposes. No identifiers or raw response. */
export function accountUsage(status: JsonObject, fetchedAtMs: number): AccountUsage {
  return {
    ...(typeof status.billingStrategy === "string" ? { billingStrategy: status.billingStrategy } : {}),
    dailyRemainingPercent: finiteNumber(status.dailyQuotaRemainingPercent),
    weeklyRemainingPercent: finiteNumber(status.weeklyQuotaRemainingPercent),
    dailyResetAtMs: unixToMs(status.dailyQuotaResetAtUnix),
    weeklyResetAtMs: unixToMs(status.weeklyQuotaResetAtUnix),
    fetchedAtMs,
  };
}

type EntryLike = { type?: unknown; message?: { role?: unknown; provider?: unknown; usage?: Record<string, unknown> } } | null | undefined;

export function sessionUsage(entries: readonly unknown[]): SessionUsage {
  const total: SessionUsage = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const entry of entries as readonly EntryLike[]) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || message.provider !== "devin") continue;
    total.requests++;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = finiteNumber(message.usage?.[key]);
      if (value !== undefined && value > 0) total[key] += value;
    }
  }
  return total;
}

/** Same abbreviation as the Pi footer: 999, 1.2k, 12k, 1.2M. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** 10-cell bar, same as the `pi-ollama-cloud` status. Example: 98% → `▕█████████░▏`. */
export function progressBar(percent: number, cells = 10): string {
  const filled = Math.min(Math.max(Math.floor((percent / 100) * cells), 0), cells);
  return `▕${"█".repeat(filled)}${"░".repeat(cells - filled)}▏`;
}

/** The less remains, the stronger the warning color. */
export function remainingTone(percent: number): UsageTone {
  return percent <= 20 ? "error" : percent <= 40 ? "warning" : "success";
}

function budgetTone(used: number, limit: number): UsageTone {
  return used >= limit ? "error" : used / limit >= 0.75 ? "warning" : "success";
}

function hasQuota(account: AccountUsage | undefined): account is AccountUsage & { dailyRemainingPercent: number; weeklyRemainingPercent: number } {
  return account?.billingStrategy === QUOTA_STRATEGY && account.dailyRemainingPercent !== undefined && account.weeklyRemainingPercent !== undefined;
}

/**
 * One-line status text. Example: `devin day ▕█████████░▏98% week ▕█████████░▏98% · ↑263 ↓49`.
 * Bars show the remaining quota; without quota data only tokens are shown.
 */
export function usageStatusText(account: AccountUsage | undefined, session: SessionUsage, paint: UsagePainter = plain): string {
  const quota = hasQuota(account)
    ? [["day", account.dailyRemainingPercent], ["week", account.weeklyRemainingPercent]]
      .map(([label, percent]) => " " + paint(remainingTone(percent as number), `${label} ${progressBar(percent as number)}${percent}%`)).join("")
    : "";
  return `devin${quota} · ↑${formatTokens(session.input)} ↓${formatTokens(session.output)}`;
}

const pad = (value: number) => String(value).padStart(2, "0");
function clock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function relativeTime(targetMs: number, nowMs: number): string {
  const minutes = Math.round((targetMs - nowMs) / 60_000), size = Math.abs(minutes);
  // Rounding to 0 minutes loses the sign, so the raw difference decides past or future.
  if (size < 1) return targetMs >= nowMs ? "soon" : "just now";
  const phrase = (amount: string) => minutes > 0 ? `in ${amount}` : `${amount} ago`;
  if (size < 60) return phrase(`${size}m`);
  if (size < 24 * 60) {
    const hours = Math.floor(size / 60), rest = size % 60;
    return phrase(`${hours}h${rest ? ` ${rest}m` : ""}`);
  }
  return phrase(`${Math.floor(size / (24 * 60))}d`);
}

/** Details shown by `/devin`. Built only from the last account status and session records; sends no requests. */
export function usageReport(account: AccountUsage | undefined, session: SessionUsage, budget: BudgetUsage, nowMs: number): UsageLine[] {
  const lines: UsageLine[] = [];
  if (!account) {
    lines.push({ text: "Account quota · not received yet", isHeading: true });
    lines.push({ text: "  Shown after login validation or the first request." });
  } else {
    lines.push({ text: `Account quota · fetched ${clock(account.fetchedAtMs)} (${relativeTime(account.fetchedAtMs, nowMs)}) · not live`, isHeading: true });
    if (hasQuota(account)) {
      const reset = (ms: number | undefined) => ms === undefined ? "reset time unknown" : `resets ${clock(ms)} (${relativeTime(ms, nowMs)})`;
      const quota = (label: string, percent: number, resetAtMs: number | undefined): UsageLine =>
        ({ text: `  ${label} ${progressBar(percent)} ${percent}% left · ${reset(resetAtMs)}`, tone: remainingTone(percent) });
      lines.push(quota("Daily ", account.dailyRemainingPercent, account.dailyResetAtMs));
      lines.push(quota("Weekly", account.weeklyRemainingPercent, account.weeklyResetAtMs));
    } else {
      lines.push({ text: `  Not a quota-billed account (${account.billingStrategy ?? "billing strategy unknown"}). Credits are not shown.` });
    }
  }
  lines.push({ text: "This session · lead conversation (sidekick excluded)", isHeading: true });
  lines.push({ text: `  ${session.requests} ${session.requests === 1 ? "request" : "requests"} · input ${formatTokens(session.input)} · output ${formatTokens(session.output)}`
    + ` · cache read ${formatTokens(session.cacheRead)} · cache write ${formatTokens(session.cacheWrite)}` });
  lines.push({ text: `Run budget · ${budget.isActive ? "in progress" : "last run"}`, isHeading: true });
  lines.push({ text: `  ${progressBar((budget.used / budget.limit) * 100)} ${budget.used}/${budget.limit} model calls used`, tone: budgetTone(budget.used, budget.limit) });
  return lines;
}
