export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export interface SearchCacheEntry {
  ts: number;
  q: string;
  results: SearchResult[];
}

export interface PageCacheEntry {
  ts: number;
  status?: number;
  title?: string;
  content?: string;
  links?: string[] | null;
  error?: string;
  errorType?: "response-shape";
}

export interface CacheData {
  searches: Record<string, SearchCacheEntry>;
  pages: Record<string, PageCacheEntry>;
}

export type CacheLockState = "ok" | "timeout" | "unavailable" | "compromised";
export interface CacheDiagnostics {
  retainedBytes: number;
  retainedEntries: number;
  evictedEntries: number;
  diskBytes?: number;
  lastRead: "ok" | "missing" | "invalid" | "oversized" | "unreadable";
  hasWriteFailed: boolean;
  lockState?: CacheLockState;
}
export interface CacheStore {
  loadCache(): CacheData;
  saveCache(): void;
  updateCache?(mutation: (data: CacheData) => void, signal?: AbortSignal): Promise<void>;
  isFresh(entry: { ts: number; error?: string } | undefined): boolean;
  getDiagnostics?(): CacheDiagnostics;
}
export interface CacheOptions {
  path: string;
  ttlMs: number;
  failTtlMs: number;
  maxEntries: number;
  maxPersistedEntryBytes: number;
  maxCacheBytes: number;
  maxMemoryBytes: number;
  lockTimeoutMs: number;
  now: () => number;
}
