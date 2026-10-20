import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { envInt } from "../shared/http.ts";
export const CACHE_PATH =
  process.env.PI_OLLAMA_SEARCH_CACHE_PATH ?? join(getAgentDir(), "cache", "pi-ollama-cloud", "cache.json");
export const CACHE_TTL_MS = envInt("PI_OLLAMA_SEARCH_TTL_HOURS", 24) * 60 * 60 * 1000;
export const FAIL_TTL_MS = envInt("PI_OLLAMA_SEARCH_FAIL_TTL_MINUTES", 15) * 60 * 1000;
/** Max entries per map (searches/pages); oldest-ts entries are evicted beyond this. */
export const MAX_ENTRIES = envInt("PI_OLLAMA_SEARCH_MAX_ENTRIES", 500);
/** Maximum serialized UTF-8 size for one persisted entry, including its key. */
export const MAX_PERSISTED_ENTRY_BYTES = 256 * 1024;
/** Maximum serialized UTF-8 size of the complete persisted cache file. */
export const MAX_CACHE_BYTES = 8 * 1024 * 1024;

/** Retained serialized data, not process heap/RSS. */
export const MAX_MEMORY_CACHE_BYTES = 8 * 1024 * 1024;
