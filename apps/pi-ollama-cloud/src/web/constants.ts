import { CACHE_TTL_MS, FAIL_TTL_MS } from "../cache/storage.ts";
import { envInt } from "../shared/http.ts";
export const WEB_TOOLS_TIMEOUT_MS = 15000;
// Search snippets and fetch chunks are capped so a single call never floods the
// context window; the agent pages through long pages with offset/full.
export const SNIPPET_LIMIT = envInt("PI_OLLAMA_SEARCH_SNIPPET_CHARS", 500);
export const READ_CHUNK = envInt("PI_OLLAMA_SEARCH_CHUNK_CHARS", 3000);
export const SUCCESS_TTL_HOURS = CACHE_TTL_MS / 3_600_000;
export const FAIL_TTL_MINUTES = Math.round(FAIL_TTL_MS / 60_000);
