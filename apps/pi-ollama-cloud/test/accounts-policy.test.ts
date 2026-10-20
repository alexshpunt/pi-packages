import { describe, expect, it } from "vitest";
import {
  accountUnavailableReason,
  BALANCE_FAILURE_RETRY_MS,
  BALANCE_RECHECK_MS,
  chooseAccount,
  evaluatePurchaseGuard,
  exhaustedUntil,
  FALLBACK_LIMIT_RETRY_MS,
  includedRemainingFraction,
} from "../src/accounts/policy.ts";
import type { AccountHealth, AccountState, OllamaAccount } from "../src/accounts/types.ts";
import type { UsageData } from "../src/usage/api.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const MINUTE = 60_000;

function account(id: string): OllamaAccount {
  return { id, apiKey: `key-${id}`, fingerprint: id.padEnd(16, "0").slice(0, 16), source: "accounts-file" };
}
const accounts = ["default", "work", "personal"].map(account);

function state(health: Record<string, AccountHealth> = {}, overrides: Partial<AccountState> = {}): AccountState {
  const byFingerprint = Object.fromEntries(
    Object.entries(health).map(([id, value]) => [account(id).fingerprint, value]),
  );
  return { version: 1, disabledAccountIds: [], health: byFingerprint, ...overrides };
}

function snapshot(data: UsageData, ageMs = 0): AccountHealth {
  return { updatedAtMs: NOW, balance: { checkedAtMs: NOW - ageMs, data } };
}

const credits = (balance: number, purchased: number, until = "2026-11-01T00:00:00Z"): UsageData => ({
  included: { balance_usd: balance, allowance_usd: 100, period: { from: "2026-10-01T00:00:00Z", until } },
  purchased: { balance_usd: purchased },
});

describe("exhaustedUntil", () => {
  const legacy: UsageData = {
    included: {
      session: { remaining_percent: 0, resets_at: "2026-10-20T14:00:00Z" },
      weekly: { remaining_percent: 40, resets_at: "2026-10-24T00:00:00Z" },
    },
  };

  it("uses the reset time the balance endpoint reports for the window", () => {
    expect(exhaustedUntil("session", NOW, legacy)).toBe(Date.parse("2026-10-20T14:00:00Z"));
    expect(exhaustedUntil("weekly", NOW, legacy)).toBe(Date.parse("2026-10-24T00:00:00Z"));
    expect(exhaustedUntil("monthly", NOW, credits(0, 0))).toBe(Date.parse("2026-11-01T00:00:00Z"));
    expect(exhaustedUntil("unknown", NOW, legacy)).toBe(Date.parse("2026-10-20T14:00:00Z"));
  });

  it("falls back to a probe delay when no future reset is known", () => {
    expect(exhaustedUntil("session", NOW)).toBe(NOW + FALLBACK_LIMIT_RETRY_MS.session);
    const past: UsageData = { included: { session: { remaining_percent: 0, resets_at: "2026-10-20T11:00:00Z" } } };
    expect(exhaustedUntil("session", NOW, past)).toBe(NOW + FALLBACK_LIMIT_RETRY_MS.session);
    expect(exhaustedUntil("weekly", NOW)).toBe(NOW + FALLBACK_LIMIT_RETRY_MS.weekly);
  });
});

describe("includedRemainingFraction", () => {
  it("takes the tightest legacy window or the included dollar share", () => {
    expect(
      includedRemainingFraction({
        included: { session: { remaining_percent: 70 }, weekly: { remaining_percent: 20 } },
      }),
    ).toBeCloseTo(0.2);
    expect(includedRemainingFraction(credits(25, 0))).toBeCloseTo(0.25);
    expect(includedRemainingFraction({ purchased: { balance_usd: 10 } })).toBe(0);
  });
});

describe("evaluatePurchaseGuard", () => {
  it("checks an unknown balance once and allows it unverified while checks fail", () => {
    expect(evaluatePurchaseGuard(undefined, NOW)).toEqual({ action: "refresh" });
    expect(evaluatePurchaseGuard({ updatedAtMs: NOW, balanceFailedAtMs: NOW - 1000 }, NOW)).toEqual({
      action: "allow",
      isUnverified: true,
    });
    expect(evaluatePurchaseGuard({ updatedAtMs: NOW, balanceFailedAtMs: NOW - BALANCE_FAILURE_RETRY_MS }, NOW)).toEqual(
      { action: "refresh" },
    );
  });

  it("re-checks accounts without purchased credits only to notice new purchases", () => {
    expect(evaluatePurchaseGuard(snapshot(credits(1, 0), MINUTE), NOW)).toEqual({ action: "allow" });
    expect(evaluatePurchaseGuard(snapshot(credits(1, 0), BALANCE_RECHECK_MS), NOW)).toEqual({ action: "refresh" });
  });

  it("stops accounts holding purchased credits before included usage runs out", () => {
    expect(evaluatePurchaseGuard(snapshot(credits(50, 5), MINUTE), NOW)).toEqual({ action: "allow" });
    expect(evaluatePurchaseGuard(snapshot(credits(50, 5), 11 * MINUTE), NOW)).toEqual({ action: "refresh" });
    expect(evaluatePurchaseGuard(snapshot(credits(3, 5), 0), NOW)).toMatchObject({ action: "block" });
    expect(evaluatePurchaseGuard(snapshot(credits(2, 5), 6 * MINUTE), NOW)).toEqual({ action: "refresh" });
  });

  it("re-checks a blocked account once its period has reset", () => {
    expect(evaluatePurchaseGuard(snapshot(credits(1, 5, "2026-10-20T11:59:30Z"), MINUTE), NOW)).toEqual({
      action: "refresh",
    });
  });

  it("blocks low or old purchased-credit snapshots while the balance cannot be verified", () => {
    const failing = (data: UsageData, ageMs: number): AccountHealth => ({
      ...snapshot(data, ageMs),
      balanceFailedAtMs: NOW - 1000,
    });
    expect(evaluatePurchaseGuard(failing(credits(5, 5), MINUTE), NOW)).toMatchObject({ action: "block" });
    expect(evaluatePurchaseGuard(failing(credits(60, 5), 31 * MINUTE), NOW)).toMatchObject({ action: "block" });
    expect(evaluatePurchaseGuard(failing(credits(60, 5), 11 * MINUTE), NOW)).toEqual({ action: "allow" });
  });
});

describe("accountUnavailableReason", () => {
  it("reports disabled, rejected, exhausted, model-blocked, and protected accounts", () => {
    const [first] = accounts;
    expect(accountUnavailableReason(first, state({}, { disabledAccountIds: ["default"] }), NOW)).toBe("disabled");
    expect(accountUnavailableReason(first, state({ default: { updatedAtMs: NOW, isUnauthorized: true } }), NOW)).toBe(
      "API key rejected",
    );
    const exhausted = state({
      default: { updatedAtMs: NOW, exhaustedUntilMs: Date.parse("2026-10-20T14:00:00Z"), exhaustedWindow: "session" },
    });
    expect(accountUnavailableReason(first, exhausted, NOW)).toBe(
      "session usage limit reached until 2026-10-20 14:00 UTC",
    );
    expect(accountUnavailableReason(first, exhausted, Date.parse("2026-10-20T14:00:00Z"))).toBe(undefined);
    const blocked = state({ default: { ...snapshot(credits(80, 0)), blockedModels: { "big:cloud": NOW + MINUTE } } });
    expect(accountUnavailableReason(first, blocked, NOW, "big:cloud")).toBe("model big:cloud not permitted");
    expect(accountUnavailableReason(first, blocked, NOW, "small:cloud")).toBeUndefined();
    expect(accountUnavailableReason(first, blocked, NOW, "__proto__")).toBeUndefined();
    expect(accountUnavailableReason(first, state({ default: snapshot(credits(1, 5)) }), NOW)).toMatch(
      /purchased credits are protected/,
    );
  });
});

describe("chooseAccount", () => {
  const usable = (ids: string[]) => state(Object.fromEntries(ids.map((id) => [id, snapshot(credits(80, 0))])));

  it("assigns new sessions in round-robin order after the shared cursor and wraps", () => {
    const health = usable(["default", "work", "personal"]);
    expect(chooseAccount({ accounts, state: health, nowMs: NOW })).toMatchObject({
      account: { id: "default" },
      isNewAssignment: true,
    });
    expect(
      chooseAccount({ accounts, state: { ...health, lastAssignedAccountId: "default" }, nowMs: NOW })?.account.id,
    ).toBe("work");
    expect(
      chooseAccount({ accounts, state: { ...health, lastAssignedAccountId: "personal" }, nowMs: NOW })?.account.id,
    ).toBe("default");
    expect(
      chooseAccount({ accounts, state: { ...health, lastAssignedAccountId: "removed" }, nowMs: NOW })?.account.id,
    ).toBe("default");
  });

  it("keeps a usable bound account regardless of the cursor", () => {
    const health = { ...usable(["default", "work", "personal"]), lastAssignedAccountId: "work" };
    expect(chooseAccount({ accounts, state: health, boundAccountId: "personal", nowMs: NOW })).toEqual({
      account: accounts[2],
      isNewAssignment: false,
    });
  });

  it("moves an unusable bound account to the next usable account and skips excluded ones", () => {
    const health = usable(["default", "work", "personal"]);
    health.health[account("work").fingerprint].exhaustedUntilMs = NOW + MINUTE;
    const choice = chooseAccount({
      accounts,
      state: { ...health, lastAssignedAccountId: "default" },
      boundAccountId: "work",
      nowMs: NOW,
    });
    expect(choice).toEqual({ account: accounts[2], isNewAssignment: true });
    expect(
      chooseAccount({
        accounts,
        state: { ...health, lastAssignedAccountId: "default" },
        excludedIds: new Set(["personal"]),
        nowMs: NOW,
      })?.account.id,
    ).toBe("default");
  });

  it("returns undefined when no account can serve the request", () => {
    expect(
      chooseAccount({
        accounts,
        state: state({}, { disabledAccountIds: ["default", "work", "personal"] }),
        nowMs: NOW,
      }),
    ).toBeUndefined();
  });
});
