import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AccountCredentialStore,
  createAccountCredentialStore,
  type StoredAccountKey,
} from "../src/accounts/credentials.ts";
import { accountFingerprint, createAccountRouter, NO_ACCOUNT_MESSAGE } from "../src/accounts/router.ts";
import { createSessionAccountBinding, type SessionAccountBinding } from "../src/accounts/session.ts";
import { createAccountStateStore } from "../src/accounts/state.ts";
import type { OllamaAccount } from "../src/accounts/types.ts";
import { OllamaHttpError } from "../src/shared/http.ts";
import type { UsageData } from "../src/usage/api.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const healthy: UsageData = {
  included: {
    balance_usd: 80,
    allowance_usd: 100,
    period: { from: "2026-10-01T00:00:00Z", until: "2026-11-01T00:00:00Z" },
  },
  purchased: { balance_usd: 0 },
};
const protectedCredits: UsageData = {
  included: {
    balance_usd: 2,
    allowance_usd: 100,
    period: { from: "2026-10-01T00:00:00Z", until: "2026-11-01T00:00:00Z" },
  },
  purchased: { balance_usd: 5 },
};

let directory: string;
let credentialsPath: string;
let statePath: string;
let entries: StoredAccountKey[];
let clock: number;

function credentialStore(
  resolve?: () => Promise<StoredAccountKey[]>,
): AccountCredentialStore & { resolve: ReturnType<typeof vi.fn> } {
  return {
    path: credentialsPath,
    list: async () => entries.map((entry) => entry.id),
    resolve: vi.fn(resolve ?? (async () => entries)),
    add: async () => {},
    remove: async () => true,
  };
}

function setEntries(next: StoredAccountKey[]) {
  entries = next;
  // The router reloads the accounts file when its revision changes.
  writeFileSync(credentialsPath, JSON.stringify(next.map((entry) => entry.id)) + " ".repeat(entries.length));
}

function router(
  options: { fetchBalance?: (key: string) => Promise<UsageData>; resolve?: () => Promise<StoredAccountKey[]> } = {},
) {
  const fetchBalance = vi.fn(options.fetchBalance ?? (async () => healthy));
  const credentials = credentialStore(options.resolve);
  const now = () => clock;
  const instance = createAccountRouter({
    credentials,
    state: createAccountStateStore({ path: statePath, now }),
    fetchBalance,
    now,
  });
  return { router: instance, fetchBalance, credentials };
}

function session(
  id: string,
): SessionAccountBinding & { appendEntry: ReturnType<typeof vi.fn>; notifier: ReturnType<typeof vi.fn> } {
  const appendEntry = vi.fn();
  const notifier = vi.fn();
  const binding = createSessionAccountBinding(appendEntry);
  binding.start({ getSessionId: () => id, getEntries: () => [] });
  binding.setNotifier(notifier);
  return Object.assign(binding, { appendEntry, notifier });
}

async function acquiredId(
  instance: ReturnType<typeof router>["router"],
  binding: SessionAccountBinding,
  modelId?: string,
) {
  const result = await instance.acquire({ primaryKey: "key-default", binding, modelId });
  if (!result.ok) throw new Error(result.message);
  return result.account.id;
}

function account(list: OllamaAccount[], id: string): OllamaAccount {
  const found = list.find((item) => item.id === id);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ollama-router-"));
  credentialsPath = join(directory, "ollama-cloud-accounts.json");
  statePath = join(directory, "ollama-cloud-account-state.json");
  clock = NOW;
  setEntries([
    { id: "work", apiKey: "key-work" },
    { id: "personal", apiKey: "key-personal" },
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("account router rotation", () => {
  it("rotates new sessions across processes and keeps each session on its account", async () => {
    const first = router();
    const second = router();
    const sessions = ["s1", "s2", "s3", "s4"].map(session);
    expect(await acquiredId(first.router, sessions[0])).toBe("default");
    expect(await acquiredId(second.router, sessions[1])).toBe("work");
    expect(await acquiredId(first.router, sessions[2])).toBe("personal");
    expect(await acquiredId(second.router, sessions[3])).toBe("default");
    expect(await acquiredId(first.router, sessions[0])).toBe("default");
    expect(await acquiredId(first.router, sessions[1])).toBe("work");
    for (const [index, binding] of sessions.entries()) {
      expect(binding.appendEntry).toHaveBeenCalledOnce();
      expect(binding.appendEntry.mock.calls[0][1]).toEqual({
        sessionId: `s${index + 1}`,
        accountId: ["default", "work", "personal", "default"][index],
      });
    }
    // One balance check per account serves both processes through the shared state.
    expect(first.fetchBalance.mock.calls.length + second.fetchBalance.mock.calls.length).toBe(3);
    expect(sessions.some((binding) => binding.notifier.mock.calls.length > 0)).toBe(false);
  });

  it("assigns one account to concurrent first requests of the same session", async () => {
    const { router: instance } = router();
    const binding = session("s1");
    const results = await Promise.all([1, 2, 3].map(() => acquiredId(instance, binding)));
    expect(results).toEqual(["default", "default", "default"]);
    expect(binding.appendEntry).toHaveBeenCalledOnce();
    expect(await acquiredId(instance, session("s2"))).toBe("work");
  });

  it("restores a recorded binding instead of taking the next account", async () => {
    const { router: instance } = router();
    await acquiredId(instance, session("s1"));
    const resumed = createSessionAccountBinding(vi.fn());
    resumed.start({
      getSessionId: () => "resumed",
      getEntries: () => [
        {
          type: "custom",
          customType: "ollama-cloud-account",
          data: { sessionId: "resumed", accountId: "personal" },
          id: "e1",
          parentId: null,
          timestamp: "2026-10-20T00:00:00Z",
        },
      ],
    });
    expect(await acquiredId(instance, resumed)).toBe("personal");
    expect(await acquiredId(instance, session("s3"))).toBe("work");
  });
});

describe("account router failures", () => {
  it("moves the session after a usage limit, notifies once, and adopts the reported reset", async () => {
    const legacy: UsageData = { included: { session: { remaining_percent: 10 } }, purchased: { balance_usd: 0 } };
    const withReset: UsageData = {
      included: { session: { remaining_percent: 0, resets_at: "2026-10-20T14:00:00Z" } },
      purchased: { balance_usd: 0 },
    };
    const calls = new Map<string, number>();
    let releaseReset!: () => void;
    const resetReported = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const { router: instance } = router({
      fetchBalance: async (key) => {
        calls.set(key, (calls.get(key) ?? 0) + 1);
        if (key !== "key-default" || (calls.get(key) ?? 0) === 1) return legacy;
        await resetReported;
        return withReset;
      },
    });
    const binding = session("s1");
    expect(await acquiredId(instance, binding)).toBe("default");
    const { accounts } = await instance.listAccounts("key-default");
    await instance.reportFailure(account(accounts, "default"), { kind: "usage-limit", window: "session" });
    const provisional = instance.readState().health[accountFingerprint("key-default")].exhaustedUntilMs;
    expect(provisional).toBe(NOW + 30 * 60_000);
    expect(await acquiredId(instance, binding)).toBe("work");
    expect(binding.notifier).toHaveBeenCalledOnce();
    expect(binding.notifier.mock.calls[0][0]).toMatch(/"default" is unavailable \(session usage limit reached until/);
    expect(binding.notifier.mock.calls[0][0]).toContain('now uses "work"');
    releaseReset();
    await instance.settle();
    expect(instance.readState().health[accountFingerprint("key-default")].exhaustedUntilMs).toBe(
      Date.parse("2026-10-20T14:00:00Z"),
    );
    expect(await acquiredId(instance, binding)).toBe("work");
    clock = Date.parse("2026-10-20T14:00:00Z");
    expect(await acquiredId(instance, session("s2"))).toBe("personal");
  });

  it("skips rejected keys from balance checks and re-resolves file keys after a rejection", async () => {
    const {
      router: instance,
      credentials,
      fetchBalance,
    } = router({
      fetchBalance: async (key) => {
        if (key === "key-default") throw new OllamaHttpError("authentication error", 401, "unauthorized");
        return healthy;
      },
    });
    expect(await acquiredId(instance, session("s1"))).toBe("work");
    expect(instance.readState().health[accountFingerprint("key-default")].isUnauthorized).toBe(true);
    const { accounts } = await instance.listAccounts("key-default");
    const resolveCalls = credentials.resolve.mock.calls.length;
    await instance.reportFailure(account(accounts, "work"), { kind: "unauthorized" });
    await instance.listAccounts("key-default");
    expect(credentials.resolve.mock.calls.length).toBe(resolveCalls + 1);
    expect(await acquiredId(instance, session("s2"))).toBe("personal");
    fetchBalance.mockImplementation(async () => healthy);
    await instance.resetHealth(accounts);
    expect(await acquiredId(instance, session("s3"))).toBe("default");
  });

  it("re-resolves a rotated environment reference after a balance 401 without changing the accounts file", async () => {
    vi.stubEnv("OLLAMA_ROUTER_ROTATING_KEY", "key-rejected");
    writeFileSync(credentialsPath, JSON.stringify({ work: { type: "api_key", key: "$OLLAMA_ROUTER_ROTATING_KEY" } }));
    const revision = statSync(credentialsPath);
    const credentials = createAccountCredentialStore(credentialsPath);
    const resolve = vi.spyOn(credentials, "resolve");
    const fetchBalance = vi.fn(async (key: string) => {
      if (key === "key-rejected") throw new OllamaHttpError("authentication error", 401, "unauthorized");
      return healthy;
    });
    const instance = createAccountRouter({
      credentials,
      state: createAccountStateStore({ path: statePath, now: () => clock }),
      fetchBalance,
      now: () => clock,
    });
    const binding = session("s1");
    expect((await instance.acquire({ primaryKey: undefined, binding })).ok).toBe(false);
    expect(instance.readState().health[accountFingerprint("key-rejected")]).toMatchObject({
      isUnauthorized: true,
      balanceFailedAtMs: NOW,
    });
    vi.stubEnv("OLLAMA_ROUTER_ROTATING_KEY", "key-rotated");
    expect(statSync(credentialsPath)).toMatchObject({
      ino: revision.ino,
      size: revision.size,
      mtimeMs: revision.mtimeMs,
    });
    const recovered = await instance.acquire({ primaryKey: undefined, binding });
    expect(recovered).toMatchObject({ ok: true, account: { id: "work", apiKey: "key-rotated" } });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(fetchBalance.mock.calls.map(([key]) => key)).toEqual(["key-rejected", "key-rotated"]);
    expect(instance.readState().health[accountFingerprint("key-rotated")]?.isUnauthorized).toBeUndefined();
  });

  it("reloads resolved file keys on the next account listing after a balance 401", async () => {
    const { router: instance, credentials } = router({
      fetchBalance: async () => {
        throw new OllamaHttpError("authentication error", 401, "unauthorized");
      },
    });
    const { accounts } = await instance.listAccounts(undefined);
    await instance.refreshBalance(accounts[0]);
    entries = [{ id: "work", apiKey: "key-rotated" }];
    const refreshed = await instance.listAccounts(undefined);
    expect(refreshed.accounts).toMatchObject([{ id: "work", apiKey: "key-rotated" }]);
    expect(credentials.resolve).toHaveBeenCalledTimes(2);
  });

  it("keeps resolved credentials cached after a non-authentication balance failure", async () => {
    const { router: instance, credentials } = router({
      fetchBalance: async () => {
        throw new OllamaHttpError("server error", 500, "fixture");
      },
    });
    const { accounts } = await instance.listAccounts(undefined);
    await instance.refreshBalance(accounts[0]);
    await instance.listAccounts(undefined);
    expect(credentials.resolve).toHaveBeenCalledOnce();
    expect(instance.readState().health[accounts[0].fingerprint]?.isUnauthorized).toBeUndefined();
  });

  it("avoids an account only for the model it refused", async () => {
    const { router: instance } = router();
    const binding = session("s1");
    expect(await acquiredId(instance, binding, "big:cloud")).toBe("default");
    const { accounts } = await instance.listAccounts("key-default");
    await instance.reportFailure(account(accounts, "default"), { kind: "forbidden" }, { modelId: "big:cloud" });
    expect(await acquiredId(instance, binding, "big:cloud")).toBe("work");
    const other = session("s2");
    await instance.setDisabled("work", true);
    expect(await acquiredId(instance, other, "small:cloud")).toBe("personal");
    expect(await acquiredId(instance, session("s3"), "small:cloud")).toBe("default");
  });
});

describe("purchased-credit protection", () => {
  it("skips accounts that would start spending purchased credits", async () => {
    const { router: instance } = router({
      fetchBalance: async (key) => (key === "key-default" ? protectedCredits : healthy),
    });
    expect(await acquiredId(instance, session("s1"))).toBe("work");
  });

  it("fails with a non-retryable message when every account is protected or unavailable", async () => {
    const { router: instance } = router({ fetchBalance: async () => protectedCredits });
    const result = await instance.acquire({ primaryKey: "key-default", binding: session("s1") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("quota exceeded");
    expect(result.message).toContain("default: included usage nearly used; purchased credits are protected");
    expect(result.message).toContain("work: included usage nearly used");
    expect(isRetryableAssistantError({ stopReason: "error", errorMessage: result.message } as never)).toBe(false);
  });

  it("allows an account once unverified when the balance check fails, without retrying it per request", async () => {
    setEntries([]);
    const { router: instance, fetchBalance } = router({
      fetchBalance: async () => {
        throw new Error("Ollama Cloud balance failed: transport error (offline). Try again shortly.");
      },
    });
    expect(await acquiredId(instance, session("s1"))).toBe("default");
    expect(await acquiredId(instance, session("s2"))).toBe("default");
    expect(fetchBalance).toHaveBeenCalledOnce();
    clock += 61_000;
    expect(await acquiredId(instance, session("s3"))).toBe("default");
    expect(fetchBalance).toHaveBeenCalledTimes(2);
  });

  it("re-checks accounts without purchased credits after the re-check interval", async () => {
    setEntries([]);
    const { router: instance, fetchBalance } = router();
    const binding = session("s1");
    await acquiredId(instance, binding);
    clock += 14 * 60_000;
    await acquiredId(instance, binding);
    expect(fetchBalance).toHaveBeenCalledOnce();
    clock += 60_000;
    await acquiredId(instance, binding);
    expect(fetchBalance).toHaveBeenCalledTimes(2);
  });
});

describe("account listing", () => {
  it("keeps Pi's account usable with duplicate keys or a broken accounts file", async () => {
    setEntries([
      { id: "copy", apiKey: "key-default" },
      { id: "bad", error: "The API key or its $ENV/!command reference could not be resolved." },
    ]);
    const { router: instance } = router();
    const listed = await instance.listAccounts("key-default");
    expect(listed.accounts.map((item) => item.id)).toEqual(["default"]);
    expect(listed.problems).toEqual([
      { id: "copy", error: "Uses the same API key as another account; skipped." },
      { id: "bad", error: "The API key or its $ENV/!command reference could not be resolved." },
    ]);
    const broken = router({
      resolve: async () => {
        throw new Error("Could not read the Ollama Cloud accounts file (/x). It must be valid auth.json-format JSON.");
      },
    });
    const brokenList = await broken.router.listAccounts("key-default");
    expect(brokenList.accounts.map((item) => item.id)).toEqual(["default"]);
    expect(brokenList.problems[0]).toMatchObject({ id: "(accounts file)" });
    expect(await acquiredId(broken.router, session("s1"))).toBe("default");
  });

  it("returns the missing-key message when no account exists", async () => {
    rmSync(credentialsPath);
    const { router: instance, credentials } = router();
    expect(await instance.acquire({ primaryKey: undefined, binding: session("s1") })).toEqual({
      ok: false,
      message: NO_ACCOUNT_MESSAGE,
    });
    expect(credentials.resolve).not.toHaveBeenCalled();
  });
});
