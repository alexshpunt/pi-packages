import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountStatePath,
  createAccountStateStore,
  decodeAccountState,
  emptyAccountState,
  pruneAccountState,
} from "../src/accounts/state.ts";
import type { AccountState } from "../src/accounts/types.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

const NOW = Date.parse("2026-10-20T12:00:00Z");
const FINGERPRINT = "0123456789abcdef";
let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ollama-account-state-"));
  path = join(directory, "agent", "ollama-cloud-account-state.json");
});

afterEach(() => {
  vi.mocked(renameSync).mockClear();
  rmSync(directory, { recursive: true, force: true });
});

describe("decodeAccountState", () => {
  it("keeps valid entries and drops invalid or prototype-sensitive ones", () => {
    const state = decodeAccountState({
      version: 1,
      lastAssignedAccountId: "work",
      disabledAccountIds: ["a", "a", 3],
      health: {
        [FINGERPRINT]: {
          updatedAtMs: NOW,
          exhaustedUntilMs: NOW + 1,
          exhaustedWindow: "weekly",
          isUnauthorized: true,
          blockedModels: JSON.parse('{"__proto__": 1, "model:cloud": 5, "bad": "x"}'),
          balance: { checkedAtMs: NOW, data: { included: { monthly: { remaining_percent: 50 } } } },
          balanceFailedAtMs: NOW,
        },
        "not-a-fingerprint": { updatedAtMs: NOW },
        fedcba9876543210: { updatedAtMs: "x" },
        "00000000000000aa": { updatedAtMs: NOW, balance: { checkedAtMs: NOW, data: { included: "bad" } } },
      },
    });
    expect(state).toEqual({
      version: 1,
      lastAssignedAccountId: "work",
      disabledAccountIds: ["a"],
      health: {
        [FINGERPRINT]: {
          updatedAtMs: NOW,
          exhaustedUntilMs: NOW + 1,
          exhaustedWindow: "weekly",
          isUnauthorized: true,
          blockedModels: { "model:cloud": 5 },
          balance: { checkedAtMs: NOW, data: { included: { monthly: { remaining_percent: 50 } } } },
          balanceFailedAtMs: NOW,
        },
        "00000000000000aa": { updatedAtMs: NOW },
      },
    });
    expect(Object.getPrototypeOf(state.health[FINGERPRINT].blockedModels)).toBe(Object.prototype);
  });

  it("returns an empty state for other versions and non-objects", () => {
    expect(decodeAccountState({ version: 2, health: {} })).toEqual(emptyAccountState());
    expect(decodeAccountState(null)).toEqual(emptyAccountState());
    expect(decodeAccountState([])).toEqual(emptyAccountState());
  });
});

describe("pruneAccountState", () => {
  it("drops expired markers, stale entries, and excess entries", () => {
    const state: AccountState = {
      version: 1,
      disabledAccountIds: [],
      health: {
        [FINGERPRINT]: {
          updatedAtMs: NOW,
          exhaustedUntilMs: NOW - 1,
          exhaustedWindow: "session",
          blockedModels: { old: NOW - 1, current: NOW + 1 },
        },
        "1111111111111111": { updatedAtMs: NOW - 31 * 24 * 60 * 60_000 },
      },
    };
    for (let index = 0; index < 70; index++) {
      state.health[(0x1000 + index).toString(16).padStart(16, "0")] = { updatedAtMs: NOW - index - 1 };
    }
    pruneAccountState(state, NOW);
    expect(state.health[FINGERPRINT]).toEqual({ updatedAtMs: NOW, blockedModels: { current: NOW + 1 } });
    expect(state.health["1111111111111111"]).toBeUndefined();
    expect(Object.keys(state.health)).toHaveLength(64);
  });
});

describe("account state store", () => {
  it("defaults to Pi's agent directory", () => {
    expect(accountStatePath(directory)).toBe(join(directory, "ollama-cloud-account-state.json"));
  });

  it("persists updates with mode 0600 and returns copies", async () => {
    const store = createAccountStateStore({ path, now: () => NOW });
    expect(store.read()).toEqual(emptyAccountState());
    const result = await store.update((state) => {
      state.lastAssignedAccountId = "work";
      state.health[FINGERPRINT] = { updatedAtMs: NOW, isUnauthorized: true };
      return "done";
    });
    expect(result).toBe("done");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ lastAssignedAccountId: "work" });
    const copy = store.read();
    copy.lastAssignedAccountId = "mutated";
    expect(store.read().lastAssignedAccountId).toBe("work");
  });

  it("sees changes written by another process and recovers from a corrupt file", async () => {
    const first = createAccountStateStore({ path, now: () => NOW });
    const second = createAccountStateStore({ path, now: () => NOW });
    await first.update((state) => {
      state.lastAssignedAccountId = "a";
    });
    expect(second.read().lastAssignedAccountId).toBe("a");
    writeFileSync(path, "{not json");
    expect(first.read()).toEqual(emptyAccountState());
    await second.update((state) => {
      state.lastAssignedAccountId = "b";
    });
    expect(first.read().lastAssignedAccountId).toBe("b");
  });

  it.each([false, true])("persists memory-only changes after a lock timeout (existing file: %s)", async (hasFile) => {
    const store = createAccountStateStore({ path, now: () => NOW });
    if (hasFile)
      await store.update((state) => {
        state.lastAssignedAccountId = "default";
      });
    mkdirSync(dirname(path), { recursive: true });
    const release = lockfile.lockSync(path, { realpath: false });
    try {
      await store.update((state) => {
        state.disabledAccountIds.push("work");
        state.health[FINGERPRINT] = { updatedAtMs: NOW, isUnauthorized: true };
      });
    } finally {
      release();
    }
    expect(store.read().disabledAccountIds).toEqual(["work"]);
    await store.update((state) => {
      state.lastAssignedAccountId = "other";
    });
    const saved = createAccountStateStore({ path }).read();
    expect(saved.disabledAccountIds).toEqual(["work"]);
    expect(saved.health[FINGERPRINT]?.isUnauthorized).toBe(true);
    expect(saved.lastAssignedAccountId).toBe("other");
  });

  it("persists memory-only changes after a failed write when the file is unchanged", async () => {
    const store = createAccountStateStore({ path, now: () => NOW });
    await store.update((state) => {
      state.lastAssignedAccountId = "default";
    });
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("fixture write failure");
    });
    await store.update((state) => {
      state.disabledAccountIds.push("work");
    });
    expect(store.read().disabledAccountIds).toEqual(["work"]);
    expect(createAccountStateStore({ path }).read().disabledAccountIds).toEqual([]);
    await store.update((state) => {
      state.lastAssignedAccountId = "other";
    });
    expect(createAccountStateStore({ path }).read()).toMatchObject({
      disabledAccountIds: ["work"],
      lastAssignedAccountId: "other",
    });
  });

  it("uses a peer's later file revision instead of reviving memory-only changes", async () => {
    const store = createAccountStateStore({ path, now: () => NOW });
    const peer = createAccountStateStore({ path, now: () => NOW });
    await peer.update((state) => {
      state.lastAssignedAccountId = "default";
    });
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("fixture write failure");
    });
    await store.update((state) => {
      state.disabledAccountIds.push("work");
    });
    expect(store.read().disabledAccountIds).toEqual(["work"]);
    await peer.update((state) => {
      state.disabledAccountIds.push("personal");
    });
    await store.update((state) => {
      state.lastAssignedAccountId = "other";
    });
    expect(createAccountStateStore({ path }).read()).toMatchObject({
      disabledAccountIds: ["personal"],
      lastAssignedAccountId: "other",
    });
  });

  it("serializes concurrent read-modify-write updates without losing changes", async () => {
    const stores = [createAccountStateStore({ path }), createAccountStateStore({ path })];
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        stores[index % 2].update((state) => {
          state.disabledAccountIds.push(`account-${index}`);
        }),
      ),
    );
    expect(stores[0].read().disabledAccountIds.sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => `account-${index}`).sort(),
    );
  });
});
