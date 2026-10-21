import { isUsageLimitMessage, OllamaHttpError } from "../shared/http.ts";
import type { AccountFailure, UsageLimitWindow } from "./types.ts";

const LIMIT_WINDOW_PATTERN = /reached your (session|weekly|monthly) usage limit/i;
// Provider messages start with the status ("429 you (...)" or "429: {...}"); web errors embed "HTTP 429:".
const STATUS_PATTERNS = [/^\s*(\d{3})\b/, /\bHTTP (\d{3})\b/, /\(status (\d{3})\)/];

export function statusFromMessage(message: string): number | undefined {
  for (const pattern of STATUS_PATTERNS) {
    const match = pattern.exec(message);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function limitWindow(text: string): UsageLimitWindow {
  const match = LIMIT_WINDOW_PATTERN.exec(text);
  return match ? (match[1].toLowerCase() as UsageLimitWindow) : "unknown";
}

/**
 * Classify an Ollama Cloud failure that is specific to the credential used.
 * Transient throttling, server errors, and transport errors return undefined so
 * Pi's normal retry handles them without moving the session to another account.
 */
export function classifyAccountFailure(status: number | undefined, text: string): AccountFailure | undefined {
  if (isUsageLimitMessage(text) && (status === undefined || status === 429)) {
    return { kind: "usage-limit", window: limitWindow(text) };
  }
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403) return { kind: "forbidden" };
  return undefined;
}

const CONCURRENCY_LIMIT_PATTERN = /too many concurrent requests/i;

/**
 * The plan's concurrent request limit ("429 \"too many concurrent requests\""). It clears as soon as another
 * request on the account finishes, so it is neither an account failure nor a usage limit.
 */
export function isConcurrencyLimitMessage(message: string | undefined): boolean {
  return message !== undefined && statusFromMessage(message) === 429 && CONCURRENCY_LIMIT_PATTERN.test(message);
}

/** Classify a provider stream `errorMessage`. */
export function classifyProviderMessage(message: string | undefined): AccountFailure | undefined {
  if (!message) return undefined;
  return classifyAccountFailure(statusFromMessage(message), message);
}

/** Classify an error thrown by the web tools or the usage API. */
export function classifyThrownError(error: unknown): AccountFailure | undefined {
  if (error instanceof OllamaHttpError) {
    return classifyAccountFailure(error.status, `${error.detail ?? ""}\n${error.message}`);
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return classifyProviderMessage(message);
}

export function describeFailure(failure: AccountFailure): string {
  if (failure.kind === "usage-limit") {
    return failure.window === "unknown" ? "usage limit reached" : `${failure.window} usage limit reached`;
  }
  return failure.kind === "unauthorized" ? "API key rejected" : "model not permitted for this account";
}
