import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES };

function textLines(value: string): number {
  return value ? value.split("\n").length : 0;
}
function stringLines(value: unknown): number {
  if (typeof value === "string") return textLines(value);
  if (value && typeof value === "object")
    return Object.values(value).reduce<number>((count, item) => count + stringLines(item), 0);
  return 0;
}
export function isWithinOutputBudget(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return (
    typeof serialized === "string" &&
    Buffer.byteLength(serialized) <= DEFAULT_MAX_BYTES &&
    stringLines(value) <= DEFAULT_MAX_LINES
  );
}
function safeEnd(text: string, end: number): number {
  const previous = text.charCodeAt(end - 1);
  const current = text.charCodeAt(end);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff ? end - 1 : end;
}
/** Keep JSON escaping and UTF-8 bytes inside the budget without splitting a surrogate pair. */
function fitPrefix(text: string, start: number, limit: number, fits: (end: number) => boolean): number {
  let lower = start;
  let upper = limit;
  let best = start;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const end = Math.max(start, safeEnd(text, middle));
    if (fits(end)) {
      best = end;
      lower = middle + 1;
    } else upper = middle - 1;
  }
  return best;
}
/** Metadata is a labelled preview; cached source strings are never changed. */
export function clipField(text: string, maxJsonBytes = 1024, maxLines = 8): string {
  const fits = (value: string) =>
    Buffer.byteLength(JSON.stringify(value)) <= maxJsonBytes && textLines(value) <= maxLines;
  if (text.length <= maxJsonBytes && fits(text)) return text;
  const suffix = "… [truncated]";
  if (!fits(suffix)) throw new Error("Metadata preview budget is too small.");
  const end = fitPrefix(text, 0, Math.min(text.length, maxJsonBytes), (end) => fits(text.slice(0, end) + suffix));
  return text.slice(0, end) + suffix;
}
export function boundToolError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const bounded = clipField(message, Math.floor(DEFAULT_MAX_BYTES / 4), Math.floor(DEFAULT_MAX_LINES / 4));
  if (error instanceof Error && bounded === message) return error;
  const result = new Error(bounded);
  if (error instanceof Error) result.name = error.name;
  return result;
}
export interface PageOutputOptions {
  header: string;
  body: string;
  offset?: number;
  maxChars: number;
  details?: Record<string, unknown>;
  afterBody?: string;
  live: boolean;
  isRetained: boolean;
  continuation: (offset: number) => string;
}
export function createPagedResult(options: PageOutputOptions) {
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer.");
  const start = Math.min(offset, options.body.length);
  const total = options.body.length;
  const build = (end: number) => {
    const nextOffset = end < total ? end : undefined;
    const prefix = `${options.header}\n${start >= total ? "Already at the end, no more content." : `Chars ${start + 1}-${end} of ${total}${end < total ? ` (${total - end} remaining)` : ""}:`}\n`;
    const body = options.body.slice(start, end);
    const footer = [
      ...(nextOffset !== undefined ? [`Continue: ${options.continuation(nextOffset)}`] : []),
      ...(options.afterBody ? [options.afterBody] : []),
      options.live ? "# live query" : "# from cache",
      options.isRetained
        ? "Cache retained: continuation uses no API calls while fresh and retained; eviction or expiry may require a new call."
        : "Source not retained: repeating with an offset may call the API again. Reuse the original query/URL to refetch.",
    ].join("\n");
    return {
      content: [{ type: "text" as const, text: `${prefix}${body}\n\n${footer}` }],
      details: {
        ...options.details,
        totalChars: total,
        offset: start,
        nextOffset,
        bodyStart: prefix.length,
        bodyEnd: prefix.length + body.length,
        cacheRetained: options.isRetained,
      },
    };
  };
  if (!isWithinOutputBudget(build(start))) throw new Error("Web result metadata exceeds Pi's output budget.");
  const maximum = Math.max(
    start,
    safeEnd(options.body, Math.min(total, start + options.maxChars, start + DEFAULT_MAX_BYTES)),
  );
  if (isWithinOutputBudget(build(maximum))) return build(maximum);
  const end = fitPrefix(options.body, start, maximum, (end) => isWithinOutputBudget(build(end)));
  if (start < total && end === start)
    throw new Error("Web output budget cannot fit another character. Use a smaller result.");
  return build(end);
}
