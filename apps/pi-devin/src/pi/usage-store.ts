import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccountUsage } from "./usage.ts";

const SCHEMA_VERSION = 1;
const SCOPE = /^[a-f0-9]{64}$/;
const NUMBER_FIELDS = ["dailyRemainingPercent", "weeklyRemainingPercent", "dailyResetAtMs", "weeklyResetAtMs"] as const;

/**
 * Last account quota received by any Pi process that shares the agent directory, such as subagents and the Fusion sidekick.
 * Keyed by the credential scope hash. No token, account ID or raw response is stored.
 */
export interface AccountUsageStore {
  read(scope: string): AccountUsage | undefined;
  /** Replaces the record unless the stored one for the same scope was fetched later. */
  write(scope: string, usage: AccountUsage): void;
}

export function accountUsagePath(agentDir: string): string {
  return join(agentDir, "pi-devin", "account-usage.json");
}

const isNotOlder = (current: AccountUsage | undefined, next: AccountUsage) => !current || next.fetchedAtMs >= current.fetchedAtMs;

/** Default store so SDK callers and tests never write to the real agent directory. */
export function memoryAccountUsageStore(): AccountUsageStore {
  let record: { scope: string; usage: AccountUsage } | undefined;
  return {
    read: (scope) => record?.scope === scope ? { ...record.usage } : undefined,
    write(scope, usage) {
      if (record?.scope !== scope || isNotOlder(record.usage, usage)) record = { scope, usage: { ...usage } };
    },
  };
}

function parseUsage(value: unknown): AccountUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (!Number.isSafeInteger(entry.fetchedAtMs) || (entry.fetchedAtMs as number) < 0) return undefined;
  if (entry.billingStrategy !== undefined && typeof entry.billingStrategy !== "string") return undefined;
  const usage: AccountUsage = { fetchedAtMs: entry.fetchedAtMs as number, ...(typeof entry.billingStrategy === "string" ? { billingStrategy: entry.billingStrategy } : {}) };
  for (const key of NUMBER_FIELDS) {
    const field = entry[key];
    if (field === undefined) continue;
    if (typeof field !== "number" || !Number.isFinite(field)) return undefined;
    usage[key] = field;
  }
  return usage;
}

/** An unreadable or malformed file reads as no record and is not repaired by reading. Writes are replaced atomically within the same directory. */
export function fileAccountUsageStore(path: string): AccountUsageStore {
  const readRecord = () => {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (value.schemaVersion !== SCHEMA_VERSION || typeof value.scope !== "string" || !SCOPE.test(value.scope)) return undefined;
      const usage = parseUsage(value.usage);
      return usage && { scope: value.scope, usage };
    } catch { return undefined; }
  };
  return {
    read(scope) {
      const record = readRecord();
      return record?.scope === scope ? record.usage : undefined;
    },
    write(scope, usage) {
      const current = readRecord();
      if (current?.scope === scope && !isNotOlder(current.usage, usage)) return;
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ schemaVersion: SCHEMA_VERSION, scope, usage }, null, 2) + "\n");
      renameSync(temporary, path);
    },
  };
}
