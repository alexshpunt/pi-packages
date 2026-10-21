import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, type Stats, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSafeKey } from "../cache/data.ts";
import { withCacheLock } from "../cache/lock.ts";
import { isRecord } from "../models/types.ts";
import { isUsageResponse } from "../usage/api.ts";
import type { AccountHealth, AccountState, UsageLimitWindow } from "./types.ts";

/**
 * Shared account health and the round-robin cursor, so every Pi process and
 * subagent skips exhausted accounts and continues the same rotation. The file
 * holds fingerprints, timestamps, and balance responses, never API keys.
 */
export const ACCOUNT_STATE_FILE_NAME = "ollama-cloud-account-state.json";
const HEALTH_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_HEALTH_ENTRIES = 64;
const MAX_DISABLED_ACCOUNTS = 64;
const MAX_STATE_BYTES = 256 * 1024;
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;
const LIMIT_WINDOWS = new Set<string>(["session", "weekly", "monthly", "unknown"]);

export function accountStatePath(agentDir = getAgentDir()): string {
  return join(agentDir, ACCOUNT_STATE_FILE_NAME);
}

export function emptyAccountState(): AccountState {
  return { version: 1, disabledAccountIds: [], health: {} };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decodeHealth(value: unknown): AccountHealth | undefined {
  if (!isRecord(value)) return undefined;
  const updatedAtMs = finiteNumber(value.updatedAtMs);
  if (updatedAtMs === undefined) return undefined;
  const health: AccountHealth = { updatedAtMs };
  const exhaustedUntilMs = finiteNumber(value.exhaustedUntilMs);
  if (exhaustedUntilMs !== undefined) {
    health.exhaustedUntilMs = exhaustedUntilMs;
    if (typeof value.exhaustedWindow === "string" && LIMIT_WINDOWS.has(value.exhaustedWindow)) {
      health.exhaustedWindow = value.exhaustedWindow as UsageLimitWindow;
    }
  }
  if (value.isUnauthorized === true) health.isUnauthorized = true;
  if (isRecord(value.blockedModels)) {
    const blockedModels: Record<string, number> = {};
    for (const [modelId, until] of Object.entries(value.blockedModels)) {
      const untilMs = finiteNumber(until);
      if (isSafeKey(modelId) && untilMs !== undefined) blockedModels[modelId] = untilMs;
    }
    if (Object.keys(blockedModels).length > 0) health.blockedModels = blockedModels;
  }
  if (isRecord(value.balance)) {
    const checkedAtMs = finiteNumber(value.balance.checkedAtMs);
    if (checkedAtMs !== undefined && isUsageResponse(value.balance.data)) {
      health.balance = { checkedAtMs, data: value.balance.data };
    }
  }
  const balanceFailedAtMs = finiteNumber(value.balanceFailedAtMs);
  if (balanceFailedAtMs !== undefined) health.balanceFailedAtMs = balanceFailedAtMs;
  return health;
}

/** Validate a parsed state file; invalid parts are dropped instead of failing requests. */
export function decodeAccountState(raw: unknown): AccountState {
  const state = emptyAccountState();
  if (!isRecord(raw) || raw.version !== 1) return state;
  if (typeof raw.lastAssignedAccountId === "string") state.lastAssignedAccountId = raw.lastAssignedAccountId;
  if (Array.isArray(raw.disabledAccountIds)) {
    state.disabledAccountIds = [
      ...new Set(raw.disabledAccountIds.filter((id): id is string => typeof id === "string")),
    ].slice(0, MAX_DISABLED_ACCOUNTS);
  }
  if (isRecord(raw.health)) {
    for (const [fingerprint, value] of Object.entries(raw.health)) {
      if (!FINGERPRINT_PATTERN.test(fingerprint)) continue;
      const health = decodeHealth(value);
      if (health) state.health[fingerprint] = health;
    }
  }
  return state;
}

/** Drop expired markers and old or excess health entries. */
export function pruneAccountState(state: AccountState, nowMs: number): void {
  for (const health of Object.values(state.health)) {
    if (health.exhaustedUntilMs !== undefined && health.exhaustedUntilMs <= nowMs) {
      delete health.exhaustedUntilMs;
      delete health.exhaustedWindow;
    }
    if (health.blockedModels) {
      for (const [modelId, untilMs] of Object.entries(health.blockedModels)) {
        if (untilMs <= nowMs) delete health.blockedModels[modelId];
      }
      if (Object.keys(health.blockedModels).length === 0) delete health.blockedModels;
    }
  }
  const retained = Object.entries(state.health)
    .filter(([, health]) => nowMs - health.updatedAtMs < HEALTH_RETENTION_MS)
    .sort(([, left], [, right]) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, MAX_HEALTH_ENTRIES);
  state.health = Object.fromEntries(retained);
}

function revisionOf(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

function currentRevision(path: string): string | undefined {
  try {
    return revisionOf(statSync(path));
  } catch {
    return undefined;
  }
}

function readStateFile(path: string): AccountState {
  try {
    if (statSync(path).size > MAX_STATE_BYTES) return emptyAccountState();
    return decodeAccountState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyAccountState();
  }
}

function writeStateFile(path: string, state: AccountState): boolean {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export interface AccountStateStore {
  readonly path: string;
  /** A copy of the latest state; re-read only when the file changes. */
  read(): AccountState;
  /**
   * Apply a synchronous mutation under the cross-process lock and persist it.
   * When the lock or write fails, the change is kept in this process's memory
   * until the file changes again.
   */
  update<T>(mutate: (state: AccountState) => T, signal?: AbortSignal): Promise<T>;
}

export interface AccountStateStoreOptions {
  path?: string;
  now?: () => number;
}

export function createAccountStateStore(options: AccountStateStoreOptions = {}): AccountStateStore {
  const filePath = () => options.path ?? accountStatePath();
  const now = options.now ?? Date.now;
  let cache: { path: string; revision: string | undefined; state: AccountState } | undefined;

  function read(): AccountState {
    const path = filePath();
    const revision = currentRevision(path);
    if (!cache || cache.path !== path || cache.revision !== revision) {
      cache = { path, revision, state: readStateFile(path) };
    }
    return structuredClone(cache.state);
  }

  return {
    get path() {
      return filePath();
    },
    read,
    async update<T>(mutate: (state: AccountState) => T, signal?: AbortSignal): Promise<T> {
      const path = filePath();
      let next: AccountState | undefined;
      let result: T | undefined;
      const lock = await withCacheLock(
        path,
        () => {
          // Preserve memory-only changes while the file revision is unchanged.
          // No await is allowed between this read and the write.
          const current = read();
          result = mutate(current);
          pruneAccountState(current, now());
          next = current;
          if (!writeStateFile(path, current)) return false;
          cache = { path, revision: currentRevision(path), state: current };
          return true;
        },
        signal,
      );
      if (!lock.ok) {
        if (!next) {
          next = read();
          result = mutate(next);
          pruneAccountState(next, now());
        }
        cache = { path, revision: currentRevision(path), state: next };
      }
      return result as T;
    },
  };
}
