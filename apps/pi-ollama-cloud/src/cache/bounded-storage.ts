import { createHash } from "node:crypto";
import { EMPTY_CACHE_BYTES, pruneCache } from "./budget.ts";
import {
  CACHE_PATH,
  CACHE_TTL_MS,
  FAIL_TTL_MS,
  MAX_CACHE_BYTES,
  MAX_ENTRIES,
  MAX_MEMORY_CACHE_BYTES,
  MAX_PERSISTED_ENTRY_BYTES,
} from "./constants.ts";
import { getCacheFileRevision, readCacheFile, writeCacheFile } from "./disk.ts";
import { CACHE_LOCK_TIMEOUT_MS, type CacheLockResult, withCacheLock, withCacheLockSync } from "./lock.ts";
import { type CacheSnapshot, entryFingerprint, mergeCache, replaceCache, snapshotCache } from "./merge.ts";
import type { CacheData, CacheDiagnostics, CacheOptions, CacheStore } from "./types.ts";

export function createCache(options: Partial<CacheOptions> = {}): CacheStore {
  const path = options.path ?? CACHE_PATH;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const failTtlMs = options.failTtlMs ?? FAIL_TTL_MS;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const maxPersistedEntryBytes = options.maxPersistedEntryBytes ?? MAX_PERSISTED_ENTRY_BYTES;
  const maxCacheBytes = options.maxCacheBytes ?? MAX_CACHE_BYTES;
  const maxMemoryBytes = options.maxMemoryBytes ?? MAX_MEMORY_CACHE_BYTES;
  const lockTimeoutMs = options.lockTimeoutMs ?? CACHE_LOCK_TIMEOUT_MS;
  for (const [name, value] of Object.entries({ maxCacheBytes, maxMemoryBytes })) {
    if (!Number.isSafeInteger(value) || value < EMPTY_CACHE_BYTES)
      throw new Error(`${name} must allow at least ${EMPTY_CACHE_BYTES} serialized bytes.`);
  }
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > CACHE_LOCK_TIMEOUT_MS)
    throw new Error(`lockTimeoutMs must be between 0 and ${CACHE_LOCK_TIMEOUT_MS}.`);
  let data: CacheData | undefined;
  let baseline: CacheSnapshot = { searches: {}, pages: {} };
  let revision: string | undefined;
  const diagnostics: CacheDiagnostics = {
    retainedBytes: EMPTY_CACHE_BYTES,
    retainedEntries: 0,
    evictedEntries: 0,
    lastRead: "missing",
    hasWriteFailed: false,
  };
  function isFresh(entry: { ts: number; error?: string } | undefined): boolean {
    if (!entry || !Number.isFinite(entry.ts) || entry.ts > now()) return false;
    return now() - entry.ts < (entry.error ? failTtlMs : ttlMs);
  }
  function boundMemory(cache: CacheData): void {
    const before = { searches: { ...cache.searches }, pages: { ...cache.pages } };
    const result = pruneCache(cache, { maxBytes: maxMemoryBytes, maxEntries }, isFresh);
    // Expiry/budget cleanup is not an explicit invalidation of a newer peer entry.
    for (const kind of ["searches", "pages"] as const) {
      for (const [key, entry] of Object.entries(before[kind])) {
        if (!Object.hasOwn(cache[kind], key) && baseline[kind][key] === entryFingerprint(entry))
          delete baseline[kind][key];
      }
    }
    diagnostics.retainedBytes = result.bytes;
    diagnostics.retainedEntries = result.entries;
    diagnostics.evictedEntries += result.removed;
  }
  function loadCache(): CacheData {
    if (!data || getCacheFileRevision(path) !== revision) {
      const read = readCacheFile(path, maxCacheBytes);
      if (data) replaceCache(data, mergeCache(data, baseline, read.data));
      else data = read.data;
      baseline = snapshotCache(read.data);
      revision = read.revision;
      diagnostics.lastRead = read.state;
    }
    boundMemory(data);
    return data;
  }
  function persist(): boolean {
    const cache = loadCache();
    const persisted: CacheData = { searches: { ...cache.searches }, pages: { ...cache.pages } };
    const result = pruneCache(
      persisted,
      { maxBytes: maxCacheBytes, maxEntries, maxEntryBytes: maxPersistedEntryBytes },
      isFresh,
    );
    const isWritten = writeCacheFile(path, persisted);
    if (isWritten) {
      diagnostics.diskBytes = result.bytes;
      revision = getCacheFileRevision(path);
      baseline = snapshotCache(cache);
    }
    return isWritten;
  }
  function record(result: CacheLockResult) {
    diagnostics.hasWriteFailed = !result.ok;
    diagnostics.lockState = result.state;
  }
  function saveCache(): void {
    loadCache();
    record(withCacheLockSync(path, persist, lockTimeoutMs));
  }
  async function updateCache(mutation: (cache: CacheData) => void, signal?: AbortSignal): Promise<void> {
    let hasApplied = false;
    const result = await withCacheLock(
      path,
      () => {
        signal?.throwIfAborted();
        mutation(loadCache());
        hasApplied = true;
        return persist();
      },
      signal,
      lockTimeoutMs,
    );
    if (!hasApplied) {
      // A lock timeout must not lose a successful response from this process's memory.
      signal?.throwIfAborted();
      mutation(loadCache());
      boundMemory(loadCache());
    }
    record(result);
  }
  return {
    loadCache,
    saveCache,
    updateCache,
    isFresh,
    getDiagnostics: () => {
      loadCache();
      return { ...diagnostics };
    },
  };
}
export const defaultCache = createCache();
export const loadCache = defaultCache.loadCache;
export const saveCache = defaultCache.saveCache;
export const isFresh = defaultCache.isFresh;
export function searchCacheKey(query: string, maxResults: number): string {
  return createHash("sha1").update(`${query}\n${maxResults}`).digest("hex");
}
