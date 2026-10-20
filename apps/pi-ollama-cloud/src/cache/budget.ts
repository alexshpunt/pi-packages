import { isSafeKey } from "./data.ts";
import type { CacheData } from "./types.ts";

export const EMPTY_CACHE_BYTES = Buffer.byteLength(JSON.stringify({ searches: {}, pages: {} }));
export interface CacheBudget {
  maxBytes: number;
  maxEntries: number;
  maxEntryBytes?: number;
}
/** Mutates maps only by evicting whole entries; never truncates stored source text. */
export function pruneCache(
  data: CacheData,
  budget: CacheBudget,
  isFresh: (entry: { ts: number; error?: string }) => boolean,
) {
  let removed = 0;
  const maps = [data.searches, data.pages];
  for (const map of maps) {
    for (const [key, entry] of Object.entries(map)) {
      if (!isSafeKey(key) || !isFresh(entry)) {
        delete map[key];
        removed += 1;
      }
    }
    const keys = Object.keys(map).sort((a, b) => map[a].ts - map[b].ts);
    for (const key of keys.slice(0, Math.max(0, keys.length - budget.maxEntries))) {
      delete map[key];
      removed += 1;
    }
  }
  const entries = maps.flatMap((map, mapIndex) =>
    Object.entries(map).map(([key, entry]) => ({
      map,
      mapIndex,
      key,
      ts: entry.ts,
      bytes: Buffer.byteLength(JSON.stringify({ [key]: entry })) - 2,
    })),
  );
  const counts = maps.map((map) => Object.keys(map).length);
  let bytes =
    EMPTY_CACHE_BYTES +
    entries.reduce((total, entry) => total + entry.bytes, 0) +
    counts.reduce((total, count) => total + Math.max(0, count - 1), 0);
  const remove = (entry: (typeof entries)[number]) => {
    if (!Object.hasOwn(entry.map, entry.key)) return;
    delete entry.map[entry.key];
    bytes -= entry.bytes + (counts[entry.mapIndex] > 1 ? 1 : 0);
    counts[entry.mapIndex] -= 1;
    removed += 1;
  };
  for (const entry of entries) if (entry.bytes + 2 > (budget.maxEntryBytes ?? Infinity)) remove(entry);
  for (const entry of entries.sort((a, b) => a.ts - b.ts)) {
    if (bytes <= budget.maxBytes) break;
    remove(entry);
  }
  return { bytes, removed, entries: counts[0] + counts[1] };
}
