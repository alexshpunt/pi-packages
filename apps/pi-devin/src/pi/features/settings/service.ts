import { Context, Effect, Layer } from "effect";
import type { FusionSelection } from "../catalog/types.ts";
import type { AccountUsage } from "../usage/types.ts";
import type { DevinPreferences, DisplaySettingsShape, FusionSettingsShape, UsageStoreShape } from "./types.ts";

export const DEFAULT_PREFERENCES: DevinPreferences = { recommendedOnly: false, showUsageStatus: false };

export class FusionSettings extends Context.Service<FusionSettings, FusionSettingsShape>()("pi-devin/FusionSettings") {}
export class DisplaySettings extends Context.Service<DisplaySettings, DisplaySettingsShape>()("pi-devin/DisplaySettings") {}
export class UsageStore extends Context.Service<UsageStore, UsageStoreShape>()("pi-devin/UsageStore") {}

/** A newer record replaces an older one of the same scope; another scope's record is always replaced. */
export const isNotOlder = (current: AccountUsage | undefined, next: AccountUsage) => !current || next.fetchedAtMs >= current.fetchedAtMs;

/** Memory stores, so SDK callers and tests never write to the real agent directory. */
export function memoryFusionSettings(initial?: FusionSelection): FusionSettingsShape {
  let current = initial;
  return {
    read: Effect.sync(() => current),
    write: (selection) => Effect.sync(() => { current = { ...selection }; }),
  };
}

export function memoryDisplaySettings(initial: Partial<DevinPreferences> = {}): DisplaySettingsShape {
  let current: DevinPreferences = { ...DEFAULT_PREFERENCES, ...initial };
  return {
    read: Effect.sync(() => ({ ...current })),
    write: (preferences) => Effect.sync(() => { current = { ...preferences }; }),
  };
}

export function memoryUsageStore(): UsageStoreShape {
  let record: { scope: string; usage: AccountUsage } | undefined;
  return {
    read: (scope) => Effect.sync(() => record?.scope === scope ? { ...record.usage } : undefined),
    write: (scope, usage) => Effect.sync(() => {
      if (record?.scope !== scope || isNotOlder(record.usage, usage)) record = { scope, usage: { ...usage } };
    }),
  };
}

export const MemorySettings = (initial: { fusion?: FusionSelection; display?: Partial<DevinPreferences> } = {}) => Layer.mergeAll(
  Layer.sync(FusionSettings, () => memoryFusionSettings(initial.fusion)),
  Layer.sync(DisplaySettings, () => memoryDisplaySettings(initial.display)),
  Layer.sync(UsageStore, memoryUsageStore),
);
