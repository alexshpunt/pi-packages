import { createHash } from "node:crypto";
import type { CacheData } from "./types.ts";

type Snapshot = Record<string, string>;
export interface CacheSnapshot {
  searches: Snapshot;
  pages: Snapshot;
}
export function entryFingerprint(entry: unknown): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}
export function snapshotCache(data: CacheData): CacheSnapshot {
  const snapshot = (entries: Record<string, unknown>): Snapshot =>
    Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entryFingerprint(entry)]));
  return { searches: snapshot(data.searches), pages: snapshot(data.pages) };
}
function mergeMap<T extends { ts: number }>(
  local: Record<string, T>,
  baseline: Snapshot,
  disk: Record<string, T>,
): Record<string, T> {
  const merged = { ...disk };
  for (const [key, entry] of Object.entries(local)) {
    const fingerprint = entryFingerprint(entry);
    if (fingerprint === baseline[key]) {
      // An unchanged old snapshot must not resurrect an entry removed by another writer.
      if (disk[key] && entryFingerprint(disk[key]) === fingerprint) merged[key] = entry;
      continue;
    }
    // A pending edit based on a now-deleted entry is discarded. A subsequent reload/refetch
    // starts from the new baseline and can insert it normally. No unbounded tombstone log.
    if (baseline[key] && !Object.hasOwn(disk, key)) continue;
    if (!disk[key] || entry.ts >= disk[key].ts) merged[key] = entry;
  }
  for (const key of Object.keys(baseline)) if (!Object.hasOwn(local, key)) delete merged[key];
  return merged;
}
export function mergeCache(local: CacheData, baseline: CacheSnapshot, disk: CacheData): CacheData {
  return {
    searches: mergeMap(local.searches, baseline.searches, disk.searches),
    pages: mergeMap(local.pages, baseline.pages, disk.pages),
  };
}
export function replaceCache(target: CacheData, next: CacheData): void {
  for (const kind of ["searches", "pages"] as const) {
    for (const key of Object.keys(target[kind])) if (!Object.hasOwn(next[kind], key)) delete target[kind][key];
  }
  Object.assign(target.searches, next.searches);
  Object.assign(target.pages, next.pages);
}
