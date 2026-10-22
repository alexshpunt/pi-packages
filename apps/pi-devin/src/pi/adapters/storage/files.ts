import { join } from "node:path";
import { Effect, Layer, Option, Schema } from "effect";
import { DisplaySettings, DEFAULT_PREFERENCES, FusionSettings, isNotOlder, UsageStore } from "../../features/settings/service.ts";
import type { DisplaySettingsShape, FusionSettingsShape, UsageStoreShape } from "../../features/settings/types.ts";
import type { FusionSelection } from "../../features/catalog/types.ts";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

const SCHEMA_VERSION = 1;

export const fusionSettingsPath = (agentDir: string) => join(agentDir, "pi-devin", "fusion.json");
export const devinSettingsPath = (agentDir: string) => join(agentDir, "pi-devin", "settings.json");
export const accountUsagePath = (agentDir: string) => join(agentDir, "pi-devin", "account-usage.json");

const ModelID = Schema.String.check(Schema.makeFilter((value: string) => value.trim() !== ""));
// Legacy IDs (`family:…`, `uid:…`) are read as is. `effectiveFusion` maps them to the current catalog's IDs.
const FusionFile = Schema.Struct({ schemaVersion: Schema.Literal(SCHEMA_VERSION), leadID: ModelID, sidekickID: ModelID });
const SettingsFile = Schema.Struct({ schemaVersion: Schema.Literal(SCHEMA_VERSION), recommendedOnly: Schema.Boolean, showUsageStatus: Schema.Boolean });
const Percent = Schema.optionalKey(Schema.Finite);
const UsageRecord = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  scope: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  usage: Schema.Struct({
    fetchedAtMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    billingStrategy: Schema.optionalKey(Schema.String),
    dailyRemainingPercent: Percent,
    weeklyRemainingPercent: Percent,
    dailyResetAtMs: Percent,
    weeklyResetAtMs: Percent,
  }),
});

/** An unreadable or malformed file reads as no saved value and is not overwritten. Writes are replaced atomically within the same directory. */
export function fileFusionSettings(path: string): FusionSettingsShape {
  return {
    read: Effect.map(readJsonFile(path, FusionFile), Option.match({
      onNone: () => undefined,
      onSome: (value): FusionSelection => ({ leadID: value.leadID, sidekickID: value.sidekickID }),
    })),
    write: (selection) => writeJsonFile(path, { schemaVersion: SCHEMA_VERSION, leadID: selection.leadID, sidekickID: selection.sidekickID }),
  };
}

/** An unreadable or malformed file reads as the defaults and is not overwritten. Writes are replaced atomically within the same directory. */
export function fileDisplaySettings(path: string): DisplaySettingsShape {
  return {
    read: Effect.map(readJsonFile(path, SettingsFile), Option.match({
      onNone: () => ({ ...DEFAULT_PREFERENCES }),
      onSome: (value) => ({ recommendedOnly: value.recommendedOnly, showUsageStatus: value.showUsageStatus }),
    })),
    write: (preferences) => writeJsonFile(path, { schemaVersion: SCHEMA_VERSION, ...preferences }),
  };
}

/** An unreadable or malformed file reads as no record and is not repaired by reading. Writes are replaced atomically within the same directory. */
export function fileUsageStore(path: string): UsageStoreShape {
  const readRecord = readJsonFile(path, UsageRecord);
  return {
    read: (scope) => Effect.map(readRecord, (record) => Option.isSome(record) && record.value.scope === scope ? { ...record.value.usage } : undefined),
    write: (scope, usage) => Effect.flatMap(readRecord, (current) => Option.isSome(current) && current.value.scope === scope && !isNotOlder(current.value.usage, usage)
      ? Effect.void : writeJsonFile(path, { schemaVersion: SCHEMA_VERSION, scope, usage })),
  };
}

export const FusionSettingsFile = (path: string) => Layer.succeed(FusionSettings, fileFusionSettings(path));
export const DisplaySettingsFile = (path: string) => Layer.succeed(DisplaySettings, fileDisplaySettings(path));
export const UsageStoreFile = (path: string) => Layer.succeed(UsageStore, fileUsageStore(path));
