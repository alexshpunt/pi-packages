import { createScopedCoordinator } from "../cache/coordinator.ts";
import { publishCache } from "../cache/publication.ts";
import { defaultCache, isSafeKey } from "../cache/storage.ts";
import type { CacheStore, PageCacheEntry } from "../cache/types.ts";
import { OLLAMA_BASE } from "../models/base.ts";
import { fetchJsonWithTimeout } from "../shared/http.ts";
import { READ_CHUNK, WEB_TOOLS_TIMEOUT_MS } from "./constants.ts";
import { fetchFailureMessage, noApiKeyError } from "./errors.ts";
import { boundToolError, clipField, createPagedResult, DEFAULT_MAX_BYTES } from "./paging.ts";
import { type FetchResponse, isFetchResponse } from "./types.ts";
export interface FetchParams {
  url: string;
  offset?: number;
  full?: boolean;
  refresh?: boolean;
}
interface FetchedPage {
  entry: PageCacheEntry;
  isCacheable: boolean;
}
const runSharedFetch = createScopedCoordinator<FetchedPage>();
async function fetchPage(url: string, apiKey: string, signal: AbortSignal): Promise<FetchedPage> {
  const res = await fetchJsonWithTimeout<FetchResponse>(
    `${OLLAMA_BASE}/api/web_fetch`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    },
    WEB_TOOLS_TIMEOUT_MS,
    signal,
  );
  signal.throwIfAborted();
  if (!res.ok) {
    return {
      entry: {
        ts: Date.now(),
        status: res.status,
        error:
          res.status === 0
            ? `Transport error: ${res.error ?? "unknown error"}`
            : `HTTP ${res.status}: ${res.error ?? "unknown error"}`,
      },
      isCacheable:
        res.status !== 0 && res.status < 500 && res.status !== 401 && res.status !== 403 && res.status !== 429,
    };
  }
  if (!isFetchResponse(res.data))
    return {
      entry: { ts: Date.now(), error: "unexpected response shape from the API", errorType: "response-shape" },
      isCacheable: false,
    };
  return {
    entry: { ts: Date.now(), title: res.data.title, content: res.data.content, links: res.data.links },
    isCacheable: true,
  };
}
async function executeWebFetchRequest(
  params: FetchParams,
  signal: AbortSignal | undefined,
  resolveApiKey: (signal?: AbortSignal) => Promise<string | undefined>,
  cacheStore: CacheStore = defaultCache,
  authScope: object = cacheStore,
) {
  signal?.throwIfAborted();
  const apiKey = await resolveApiKey(signal);
  signal?.throwIfAborted();
  if (!apiKey) noApiKeyError();

  const cache = cacheStore.loadCache();
  let entry = cache.pages[params.url];
  let live = false;
  let liveCacheable = false;
  if (params.refresh || !cacheStore.isFresh(entry)) {
    live = true;
    const previous = entry;
    const result = await runSharedFetch(
      cacheStore,
      authScope,
      { key: params.url, credential: apiKey, refresh: params.refresh },
      async (context) => {
        // Preserve 05's cancellation invalidation without canceling another waiter or deleting a newer result.
        const invalidatePrevious = () => {
          if (!previous || !isSafeKey(params.url)) return;
          void publishCache(cacheStore, (current) => {
            if (current.pages[params.url] === previous) delete current.pages[params.url];
          }).catch(() => {
            /* Cancellation cleanup is best effort; default-store failures remain in diagnostics. */
          });
        };
        context.signal.addEventListener("abort", invalidatePrevious, { once: true });
        try {
          const fetched = await fetchPage(params.url, apiKey, context.signal);
          if (isSafeKey(params.url)) {
            await publishCache(
              cacheStore,
              (current) => {
                if (fetched.isCacheable) current.pages[params.url] = fetched.entry;
                else delete current.pages[params.url];
              },
              context.signal,
              context.canPublish,
            );
          }
          return fetched;
        } finally {
          context.signal.removeEventListener("abort", invalidatePrevious);
        }
      },
      signal,
    );
    entry = result.entry;
    liveCacheable = result.isCacheable;
  }
  signal?.throwIfAborted();
  const diagnostics = cacheStore.getDiagnostics?.();
  const isRetained = cacheStore.isFresh(cache.pages[params.url]) && cache.pages[params.url] === entry;
  if (entry.error) {
    const message = fetchFailureMessage(
      params.url,
      entry,
      live ? (liveCacheable && isRetained ? "live-cached" : "live-uncached") : "cached",
    );
    throw new Error(
      message +
        (diagnostics?.hasWriteFailed ? "\nCache write failed; use refresh=true if an older entry reappears." : ""),
    );
  }
  const content = entry.content ?? "";
  const links = (entry.links ?? []).slice(0, 10).map((link) => clipField(link, 512, 4));
  const title = clipField(entry.title ?? "", 512, 4);
  const urlReference = params.url.length <= 256 ? JSON.stringify(params.url) : "<same url>";
  const cacheWarning =
    diagnostics && ["oversized", "invalid", "unreadable"].includes(diagnostics.lastRead)
      ? diagnostics.lastRead
      : undefined;
  const linkPreview =
    (params.offset ?? 0) === 0 && !params.full
      ? `\nLinks (${entry.links?.length ?? 0}; bounded previews):\n${links.map((link) => `  - ${link}`).join("\n")}`
      : "";
  return createPagedResult({
    header: `Title: ${title} (${content.length} chars total)`,
    afterBody: linkPreview,
    body: content,
    offset: params.offset,
    maxChars: params.full ? DEFAULT_MAX_BYTES : READ_CHUNK,
    live,
    isRetained,
    details: { title, links, linkCount: entry.links?.length ?? 0, cacheWarning },
    continuation: (offset) =>
      `call ollama_web_fetch(url=${urlReference}, offset=${offset}${params.full ? ", full=true" : ""})`,
  });
}
export async function executeWebFetch(...args: Parameters<typeof executeWebFetchRequest>) {
  try {
    return await executeWebFetchRequest(...args);
  } catch (error) {
    throw boundToolError(error);
  }
}
