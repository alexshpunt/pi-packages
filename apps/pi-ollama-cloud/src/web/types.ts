export interface SearchResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
  }>;
}
export interface FetchResponse {
  title: string;
  content: string;
  links: string[] | null;
}
/** Validate a parsed web_search response: must have a results array of well-formed entries. */
export function isSearchResponse(data: unknown): data is SearchResponse {
  if (data == null || typeof data !== "object") return false;
  const results = (data as SearchResponse).results;
  return (
    Array.isArray(results) &&
    results.every(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        !Array.isArray(result) &&
        typeof result.title === "string" &&
        typeof result.url === "string" &&
        typeof result.content === "string",
    )
  );
}

/** Validate a parsed web_fetch response: must have string title/content and a links array of strings (or null). */
export function isFetchResponse(data: unknown): data is FetchResponse {
  if (data == null || typeof data !== "object") return false;
  const d = data as FetchResponse;
  return (
    typeof d.title === "string" &&
    typeof d.content === "string" &&
    (d.links === null || (Array.isArray(d.links) && d.links.every((l) => typeof l === "string")))
  );
}
