export async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Link an external abort signal (e.g. a tool's cancellation signal) so the
  // request aborts on either the timeout or the caller aborting. Cleanup runs
  // in the finally block on both the happy and error paths.
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      // Keep data null and report text below.
    }
    const error =
      data && typeof data === "object" && "error" in data
        ? typeof (data as { error: unknown }).error === "object"
          ? JSON.stringify((data as { error: unknown }).error)
          : String((data as { error: unknown }).error)
        : text;
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : error };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    if (externalSignal && !externalSignal.aborted) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}
const USAGE_LIMIT_PATTERN = /\busage limit\b/i;
const MAX_ERROR_DETAIL_CHARS = 512;

/** True when an Ollama Cloud error body reports an exhausted session, weekly, or monthly usage limit. */
export function isUsageLimitMessage(text: string | undefined): boolean {
  return text !== undefined && USAGE_LIMIT_PATTERN.test(text);
}

/** A non-ok Ollama Cloud response. `detail` keeps the API's error text for failure classification. */
export class OllamaHttpError extends Error {
  readonly status: number;
  readonly detail: string | undefined;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "OllamaHttpError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Throw a user-facing error for a non-ok Ollama Cloud HTTP response, mapping
 * distinct status codes. Shared by the web tools and the usage command.
 */
export function httpError(op: string, status: number, error?: string): never {
  if (status === 0) {
    throw new OllamaHttpError(
      `Ollama Cloud ${op} failed: transport error (${error ?? "unknown"}). Try again shortly.`,
      status,
      error,
    );
  }
  if (status === 401 || status === 403) {
    throw new OllamaHttpError(
      `Ollama Cloud ${op} failed: authentication error. Check your API key in OLLAMA_API_KEY or auth.json.`,
      status,
      error,
    );
  }
  if (status === 429) {
    // Usage-limit responses name the exhausted window; keep that text so callers can tell it from throttling.
    const message = isUsageLimitMessage(error)
      ? `Ollama Cloud ${op} failed: usage limit reached (${error?.slice(0, MAX_ERROR_DETAIL_CHARS)}).`
      : `Ollama Cloud ${op} failed: rate limited. Try again shortly.`;
    throw new OllamaHttpError(message, status, error);
  }
  if (status >= 500) {
    throw new OllamaHttpError(
      `Ollama Cloud ${op} failed: server error (status ${status}). Try again shortly.`,
      status,
      error,
    );
  }
  throw new OllamaHttpError(
    `Ollama Cloud ${op} failed: unexpected response (status ${status}${error ? `: ${error}` : ""}). Try again shortly.`,
    status,
    error,
  );
}

/** Parse a positive-integer env var, falling back when unset or invalid (NaN, non-integer, <= 0). */
export function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
