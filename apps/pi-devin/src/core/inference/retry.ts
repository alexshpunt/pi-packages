import { setTimeout as delay } from "node:timers/promises";
import { awaitWithSignal, RPCError } from "../protocol/transport.ts";

const CREATION_ATTEMPTS = 5;
const RECOVERY_ATTEMPTS = 3;
const INITIAL_INTERVAL_MS = 2000;
const MAX_INTERVAL_MS = 60_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_CONNECT_CODES = new Set(["resource_exhausted", "deadline_exceeded", "internal", "unavailable"]);

export interface InferenceRetryRuntime {
  random?: () => number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface InferenceRetryEvent {
  phase: "creation" | "recovery";
  nextAttempt: number;
  limit: number;
  delayMs: number;
}

/** Backoff: starts at 2 s, doubles, jitter factor 0.5. The elapsed-time cap is disabled. */
export function inferenceRetryDelayMs(retryIndex: number, random: number): number {
  if (!Number.isInteger(retryIndex) || retryIndex < 0 || retryIndex >= CREATION_ATTEMPTS - 1) throw new Error("Invalid retry index.");
  if (!Number.isFinite(random) || random < 0 || random >= 1) throw new Error("The retry random value must be at least 0 and below 1.");
  const intervalMs = Math.min(INITIAL_INTERVAL_MS * 2 ** retryIndex, MAX_INTERVAL_MS);
  const intervalNanos = intervalMs * 1_000_000;
  return Math.floor((intervalNanos * 0.5 + random * (intervalNanos + 1)) / 1_000_000);
}

function canRetryCreation(error: unknown): boolean {
  return error instanceof RPCError && error.httpStatus !== undefined && RETRYABLE_HTTP_STATUSES.has(error.httpStatus);
}

function canRecover(error: unknown): boolean {
  return canRetryCreation(error) || (error instanceof RPCError && error.httpStatus === undefined && RETRYABLE_CONNECT_CODES.has(error.code));
}

/** Makes each attempt build a new request, separate from the same-body resend of the 415/compression fallback. */
export async function withInferenceRetries<T>(
  request: (isRecovery: boolean) => Promise<T>,
  options: { signal: AbortSignal; runtime?: InferenceRetryRuntime; onRetry?: (event: InferenceRetryEvent) => void },
): Promise<T> {
  const { signal, runtime = {} } = options;
  const random = runtime.random ?? Math.random;
  const wait = runtime.wait ?? ((delayMs: number, signal: AbortSignal) => delay(delayMs, undefined, { signal }));
  let lastError: unknown;
  for (let recovery = 0; recovery < RECOVERY_ATTEMPTS; recovery++) {
    for (let attempt = 0; attempt < CREATION_ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      try { return await request(recovery > 0); }
      catch (error) {
        signal.throwIfAborted();
        if (!canRecover(error)) throw error;
        lastError = error;
        if (!canRetryCreation(error) || attempt + 1 === CREATION_ATTEMPTS) break;
        const delayMs = inferenceRetryDelayMs(attempt, random());
        options.onRetry?.({ phase: "creation", nextAttempt: attempt + 2, limit: CREATION_ATTEMPTS, delayMs });
        try { await awaitWithSignal(wait(delayMs, signal), signal); }
        catch (error) { signal.throwIfAborted(); throw error; }
      }
    }
    signal.throwIfAborted();
    if (recovery + 1 < RECOVERY_ATTEMPTS) options.onRetry?.({ phase: "recovery", nextAttempt: recovery + 2, limit: RECOVERY_ATTEMPTS, delayMs: 0 });
  }
  throw lastError;
}
