import type { CacheData, PageCacheEntry, SearchCacheEntry } from "./types.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keys that must never come from a parsed JSON file (prototype pollution). */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isSafeKey(key: string): boolean {
  return !UNSAFE_KEYS.has(key);
}

/** Shallow shape checks so a partially corrupted cache file degrades instead of crashing tool calls. */
function isSearchEntry(v: unknown): v is SearchCacheEntry {
  return (
    isRecord(v) &&
    typeof v.ts === "number" &&
    typeof v.q === "string" &&
    Array.isArray(v.results) &&
    v.results.every(
      (r) => isRecord(r) && typeof r.title === "string" && typeof r.url === "string" && typeof r.content === "string",
    )
  );
}

function normalizeSearchEntry(entry: SearchCacheEntry): SearchCacheEntry {
  return {
    ts: entry.ts,
    q: entry.q,
    results: entry.results.map(({ title, url, content }) => ({ title, url, content })),
  };
}

function isPageEntry(v: unknown): v is PageCacheEntry {
  if (!isRecord(v) || typeof v.ts !== "number") return false;
  const fieldsValid =
    (v.status === undefined || typeof v.status === "number") &&
    (v.title === undefined || typeof v.title === "string") &&
    (v.content === undefined || typeof v.content === "string") &&
    (v.links === null ||
      v.links === undefined ||
      (Array.isArray(v.links) && v.links.every((l) => typeof l === "string"))) &&
    (v.error === undefined || (typeof v.error === "string" && v.error !== "")) &&
    (v.errorType === undefined || v.errorType === "response-shape");
  if (!fieldsValid) return false;
  // Must be either a real failure or a real success; anything else (e.g. an
  // entry with neither content nor a non-empty error) would render as a fake
  // empty success.
  return (
    (typeof v.error === "string" && v.error !== "") || (typeof v.title === "string" && typeof v.content === "string")
  );
}

function normalizePageEntry(entry: PageCacheEntry): PageCacheEntry {
  const normalized: PageCacheEntry = { ts: entry.ts };
  if (entry.status !== undefined) normalized.status = entry.status;
  if (entry.title !== undefined) normalized.title = entry.title;
  if (entry.content !== undefined) normalized.content = entry.content;
  if (entry.links !== undefined) normalized.links = entry.links;
  if (entry.error !== undefined) normalized.error = entry.error;
  if (entry.errorType !== undefined) normalized.errorType = entry.errorType;
  return normalized;
}

export function decodeCacheData(raw: unknown): CacheData | undefined {
  if (!isRecord(raw) || !isRecord(raw.searches) || !isRecord(raw.pages)) return undefined;
  const data: CacheData = { searches: {}, pages: {} };
  for (const [key, entry] of Object.entries(raw.searches)) {
    if (isSafeKey(key) && isSearchEntry(entry)) data.searches[key] = normalizeSearchEntry(entry);
  }
  for (const [key, entry] of Object.entries(raw.pages)) {
    if (isSafeKey(key) && isPageEntry(entry)) data.pages[key] = normalizePageEntry(entry);
  }
  return data;
}
