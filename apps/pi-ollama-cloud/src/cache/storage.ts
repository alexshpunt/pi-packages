export { createCache, defaultCache, isFresh, loadCache, saveCache, searchCacheKey } from "./bounded-storage.ts";
export {
  CACHE_PATH,
  CACHE_TTL_MS,
  FAIL_TTL_MS,
  MAX_CACHE_BYTES,
  MAX_ENTRIES,
  MAX_MEMORY_CACHE_BYTES,
  MAX_PERSISTED_ENTRY_BYTES,
} from "./constants.ts";
export { isSafeKey } from "./data.ts";
export type { CacheData, CacheStore, PageCacheEntry, SearchCacheEntry, SearchResult } from "./types.ts";
