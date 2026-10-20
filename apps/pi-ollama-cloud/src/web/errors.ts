import type { PageCacheEntry } from "../cache/storage.ts";
import { isUsageLimitMessage } from "../shared/http.ts";
import { FAIL_TTL_MINUTES } from "./constants.ts";
import { clipField } from "./paging.ts";
/** Throw a no-API-key error. */
export function noApiKeyError(): never {
  throw new Error("No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.");
}
/** Build a failure message with likely causes and next steps (thrown, per the AgentToolResult contract). */
export function fetchFailureMessage(
  url: string,
  entry: PageCacheEntry,
  failureState: "cached" | "live-cached" | "live-uncached",
): string {
  const lines = [
    `Ollama Cloud fetch failed: ${clipField(url, 1024, 4)}`,
    `API error: ${clipField(entry.error ?? "unknown", 4096, 12)}`,
    entry.errorType === "response-shape"
      ? "Status: live request returned an unexpected response shape (not cached; the next call retries the API)"
      : failureState === "cached"
        ? `Status: from cache (failure cached for ${FAIL_TTL_MINUTES} min; pass refresh=true to force a live retry)`
        : failureState === "live-cached"
          ? `Status: live request failed (failure cached for ${FAIL_TTL_MINUTES} min; pass refresh=true to force a live retry)`
          : "Status: live request failed (not cached; the next call retries the API)",
  ];
  if (entry.status === 401 || entry.status === 403) {
    lines.push(
      "Likely cause: authentication error.",
      "Suggestion: check your API key in OLLAMA_API_KEY or auth.json, then retry (auth failures are not cached).",
    );
  } else if (entry.status === 429 && isUsageLimitMessage(entry.error)) {
    lines.push(
      "Likely cause: the account's usage limit is reached.",
      "Suggestion: wait for the limit to reset or add another account in /ollama (not cached).",
    );
  } else if (entry.status === 429) {
    lines.push("Likely cause: rate limited.", "Suggestion: try again shortly (rate-limit failures are not cached).");
  } else if (entry.status === 0) {
    lines.push(
      "Likely cause: a transport error (timeout, cancellation, or network failure).",
      "Suggestion: try again shortly; transport failures are not cached.",
    );
  } else if (entry.errorType === "response-shape") {
    lines.push(
      "Likely cause: Ollama Cloud returned an unexpected response shape.",
      "Suggestion: try again shortly; this failure is not cached.",
    );
  } else if (entry.status !== undefined && entry.status >= 500) {
    lines.push(
      "Likely cause: Ollama server error.",
      "Suggestion: try again shortly (server failures are not cached; the next call retries the API).",
    );
  } else {
    lines.push(
      "Likely cause: anti-bot / login wall, JS-rendered page, or malformed URL.",
      "Suggestion: 1) use ollama_web_search for the site/topic; 2) check the URL; 3) retrying with offset/full will also fail — use refresh=true only if you believe the failure was transient.",
    );
  }
  return lines.join("\n");
}
