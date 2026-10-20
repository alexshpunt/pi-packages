import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type CacheStore, defaultCache } from "../cache/storage.ts";
import { createRenderResult } from "../render/result.ts";
import { FAIL_TTL_MINUTES, READ_CHUNK, SNIPPET_LIMIT, SUCCESS_TTL_HOURS } from "../web/constants.ts";
import { executeWebFetch } from "../web/fetch.ts";
import { executeWebSearch } from "../web/search.ts";
import { type AccountRequestRunner, singleAccountRunner } from "./account-requests.ts";
export function registerWebSearchTool(
  pi: ExtensionAPI,
  cacheStore: CacheStore = defaultCache,
  runWithAccount: AccountRequestRunner = singleAccountRunner,
) {
  pi.registerTool({
    name: "ollama_web_search",
    label: "Ollama Web Search",
    description:
      "Search the web for real-time information using Ollama Cloud's web search API. " +
      `Returns up to max_results results (default 5, max 10; title, URL, ${SNIPPET_LIMIT}-char snippet; [truncated] means the source is longer — ` +
      "pass expand=<index> to read that result in bounded pages; use offset from the response to continue). " +
      `Results are cached for up to ${SUCCESS_TTL_HOURS}h. Reuse costs 0 API calls only while the entry is fresh and retained. ` +
      "Eviction or expiry may require another API call. Title, URL and details fields are bounded previews. " +
      "Pass refresh=true to bypass the cache and re-call the API (e.g. results look stale). " +
      "Requires an Ollama Cloud API key.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query to execute" }),
      max_results: Type.Optional(
        Type.Integer({
          description: "Maximum number of search results to return (default: 5, max: 10)",
          default: 5,
          minimum: 1,
          maximum: 10,
        }),
      ),
      refresh: Type.Optional(
        Type.Boolean({
          description:
            "Bypass the cached search and re-call the API (default: false). The fresh result replaces the cache entry.",
          default: false,
        }),
      ),
      offset: Type.Optional(
        Type.Integer({
          description:
            "UTF-16 character offset in the expanded result, or in the formatted result list when expand is omitted. Use the returned nextOffset.",
          default: 0,
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        }),
      ),
      expand: Type.Optional(
        Type.Integer({
          description:
            "Read a bounded page of this result (1-based index) instead of snippets. " +
            "Use offset to continue; no API call only while the original search remains cached.",
          minimum: 1,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runWithAccount(ctx, signal, (resolveApiKey) =>
        executeWebSearch(params, signal, resolveApiKey, cacheStore, ctx.modelRegistry),
      );
    },
    renderCall(args, theme, _context) {
      const display = args.query ? `ollama_web_search("${args.query}")` : "ollama_web_search";
      return new Text(theme.fg("toolTitle", display), 0, 0);
    },
    renderResult: createRenderResult(),
  });
}

export function registerWebFetchTool(
  pi: ExtensionAPI,
  cacheStore: CacheStore = defaultCache,
  runWithAccount: AccountRequestRunner = singleAccountRunner,
) {
  pi.registerTool({
    name: "ollama_web_fetch",
    label: "Ollama Web Fetch",
    description:
      "Fetch and extract text content from a web page URL using Ollama Cloud's web fetch API. " +
      `Returns the page title, a ${READ_CHUNK}-char slice of the content, and links. Pages are cached for ${SUCCESS_TTL_HOURS}h. ` +
      "Pass offset=N to continue reading from char N (the output tells you the next offset), or " +
      `full=true to request the largest bounded page, not unlimited content. Eviction or expiry can require another API call. A cacheable failed URL is cached for ${FAIL_TTL_MINUTES} min ` +
      `— retrying it within the failure TTL (${FAIL_TTL_MINUTES} min) costs 0 API calls and fails the same way; pass refresh=true to ` +
      "force a live retry. Requires an Ollama Cloud API key.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch and extract content from", format: "uri" }),
      offset: Type.Optional(
        Type.Integer({
          description: "Start reading from this UTF-16 character index (default: 0); prefer the returned nextOffset.",
          default: 0,
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        }),
      ),
      full: Type.Optional(
        Type.Boolean({
          description:
            "Return the largest page within Pi output limits (default: false). Continue using nextOffset until the source is complete.",
          default: false,
        }),
      ),
      refresh: Type.Optional(
        Type.Boolean({
          description:
            "Bypass the cached page (or cached failure) and re-call the API (default: false). The fresh result replaces the cache entry.",
          default: false,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runWithAccount(ctx, signal, (resolveApiKey) =>
        executeWebFetch(params, signal, resolveApiKey, cacheStore, ctx.modelRegistry),
      );
    },
    renderCall(args, theme, _context) {
      const display = args.url ? `ollama_web_fetch("${args.url}")` : "ollama_web_fetch";
      return new Text(theme.fg("toolTitle", display), 0, 0);
    },
    renderResult: createRenderResult(),
  });
}
