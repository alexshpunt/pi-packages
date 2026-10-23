import { Effect } from "effect";
import { createScopedEffectCoordinator } from "../cache/coordinator.ts";
import { publishCacheEffect } from "../cache/publication.ts";
import { defaultCache, type SearchResult, searchCacheKey } from "../cache/storage.ts";
import type { CacheStore, SearchCacheEntry } from "../cache/types.ts";
import { OLLAMA_BASE } from "../models/base.ts";
import { fromPromise } from "../shared/effects.ts";
import { fetchJsonWithTimeoutEffect, httpError } from "../shared/http.ts";
import { SNIPPET_LIMIT, WEB_TOOLS_TIMEOUT_MS } from "./constants.ts";
import { noApiKeyError } from "./errors.ts";
import { boundToolError, clipField, createPagedResult, DEFAULT_MAX_BYTES } from "./paging.ts";
import { isSearchResponse, type SearchResponse } from "./types.ts";
export interface SearchParams {
  query: string;
  max_results?: number;
  refresh?: boolean;
  expand?: number;
  offset?: number;
}
const runSharedSearch = createScopedEffectCoordinator<SearchCacheEntry>();
export function executeWebSearchEffect(
  params: SearchParams,
  signal: AbortSignal | undefined,
  resolveApiKey: (signal?: AbortSignal) => Promise<string | undefined>,
  cacheStore: CacheStore = defaultCache,
  authScope: object = cacheStore,
) {
  return Effect.gen(function* () {
    signal?.throwIfAborted();
    const apiKey = yield* fromPromise(() => resolveApiKey(signal));
    signal?.throwIfAborted();
    if (!apiKey) {
      noApiKeyError();
    }

    const maxResults = params.max_results ?? 5;
    const cache = cacheStore.loadCache();
    const key = searchCacheKey(params.query, maxResults);
    const cached = cache.searches[key];
    let live = false;
    let entry = cached;
    if (params.refresh || !cacheStore.isFresh(cached)) {
      live = true;
      entry = yield* runSharedSearch(
        cacheStore,
        authScope,
        { key: JSON.stringify([params.query, maxResults]), credential: apiKey, refresh: params.refresh },
        (context) =>
          Effect.gen(function* () {
            const res = yield* fetchJsonWithTimeoutEffect<SearchResponse>(
              `${OLLAMA_BASE}/api/web_search`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({ query: params.query, max_results: maxResults }),
              },
              WEB_TOOLS_TIMEOUT_MS,
              context.signal,
            );
            context.signal.throwIfAborted();
            if (!res.ok) {
              if (res.status === 0)
                throw new Error(
                  `Ollama Cloud search failed: transport error (${res.error ?? "unknown"}). Not cached; the next call retries the API.`,
                );
              httpError("search", res.status, res.error);
            }
            if (!isSearchResponse(res.data))
              throw new Error("Web search failed: unexpected response shape from the API.");
            const fetched: SearchCacheEntry = {
              ts: Date.now(),
              q: params.query,
              results: res.data.results.map(({ title, url, content }) => ({ title, url, content })),
            };
            yield* publishCacheEffect(
              cacheStore,
              (current) => {
                current.searches[key] = fetched;
              },
              context.signal,
              context.canPublish,
            );
            return fetched;
          }),
        signal,
      );
    }
    signal?.throwIfAborted();
    const results = entry.results;
    const diagnostics = cacheStore.getDiagnostics?.();
    const isRetained = cacheStore.isFresh(cache.searches[key]) && cache.searches[key] === entry;
    const queryReference = params.query.length <= 256 ? JSON.stringify(params.query) : "<same query>";
    const preview = (result: SearchResult) => ({
      title: clipField(result.title, 256, 4),
      url: clipField(result.url, 512, 4),
      content: clipField(result.content.slice(0, SNIPPET_LIMIT), 1024, 8),
    });
    const cacheWarning =
      diagnostics && ["oversized", "invalid", "unreadable"].includes(diagnostics.lastRead)
        ? diagnostics.lastRead
        : undefined;
    if (params.expand !== undefined) {
      const index = params.expand;
      if (index < 1 || index > results.length) {
        throw new Error(
          `Web search expand: index ${index} out of range (this search has ${results.length} results). Use ollama_web_fetch for a URL instead.`,
        );
      }
      const result = results[index - 1];
      return createPagedResult({
        header: `Result ${index} of "${clipField(params.query, 256, 4)}"\nTitle: ${clipField(result.title, 256, 4)}\nURL: ${clipField(result.url, 512, 4)}`,
        body: result.content,
        offset: params.offset,
        maxChars: DEFAULT_MAX_BYTES,
        live,
        isRetained,
        details: { results: [preview(result)], totalResults: results.length, cacheWarning },
        continuation: (offset) =>
          `call ollama_web_search(query=${queryReference}, max_results=${maxResults}, expand=${index}, offset=${offset})`,
      });
    }
    const previews = results.slice(0, maxResults).map(preview);
    const formatted = previews
      .map((result, index) => {
        const truncated = results[index].content.length > result.content.length;
        return `${index + 1}. ${truncated ? "[truncated]" : "[complete]"} ${result.title}\n   URL: ${result.url}\n   ${result.content}`;
      })
      .join("\n\n");
    return createPagedResult({
      header: `Search results: ${results.length}. Use expand=<index> for source content; title/URL/snippet fields are bounded previews.`,
      body: formatted || "No results found.",
      offset: params.offset,
      maxChars: DEFAULT_MAX_BYTES,
      live,
      isRetained,
      details: { results: previews, totalResults: results.length, cacheWarning },
      continuation: (offset) =>
        `call ollama_web_search(query=${queryReference}, max_results=${maxResults}, offset=${offset}) to continue the result list`,
    });
  });
}

export async function executeWebSearch(...args: Parameters<typeof executeWebSearchEffect>) {
  try {
    return await Effect.runPromise(executeWebSearchEffect(...args));
  } catch (error) {
    throw boundToolError(error);
  }
}
