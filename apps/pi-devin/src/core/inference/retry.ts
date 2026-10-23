import { Duration, Effect } from "effect";
import { RPCError, type DevinError, type DevinFailure } from "../errors.ts";
import { failWith } from "../validation.ts";

const CREATION_ATTEMPTS = 5;
const RECOVERY_ATTEMPTS = 3;
const INITIAL_INTERVAL_MS = 2000;
const MAX_INTERVAL_MS = 60_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_CONNECT_CODES = new Set(["resource_exhausted", "deadline_exceeded", "internal", "unavailable"]);

export interface InferenceRetryRuntime {
  random?: () => number;
  /** Waits between attempts. Defaults to `Effect.sleep`, which the caller's interruption and guards stop. */
  wait?: (delayMs: number) => Effect.Effect<void, DevinFailure>;
}

export interface InferenceRetryEvent {
  phase: "creation" | "recovery";
  nextAttempt: number;
  limit: number;
  delayMs: number;
}

/** Backoff: starts at 2 s, doubles, jitter factor 0.5. The elapsed-time cap is disabled. */
export function inferenceRetryDelayMs(retryIndex: number, random: number): Effect.Effect<number, DevinError> {
  if (!Number.isInteger(retryIndex) || retryIndex < 0 || retryIndex >= CREATION_ATTEMPTS - 1) return failWith("Invalid retry index.");
  if (!Number.isFinite(random) || random < 0 || random >= 1) return failWith("The retry random value must be at least 0 and below 1.");
  const intervalMs = Math.min(INITIAL_INTERVAL_MS * 2 ** retryIndex, MAX_INTERVAL_MS);
  const intervalNanos = intervalMs * 1_000_000;
  return Effect.succeed(Math.floor((intervalNanos * 0.5 + random * (intervalNanos + 1)) / 1_000_000));
}

function canRetryCreation(error: DevinFailure): boolean {
  return error instanceof RPCError && error.httpStatus !== undefined && RETRYABLE_HTTP_STATUSES.has(error.httpStatus);
}

function canRecover(error: DevinFailure): boolean {
  return canRetryCreation(error) || (error instanceof RPCError && error.httpStatus === undefined && RETRYABLE_CONNECT_CODES.has(error.code));
}

/** Makes each attempt build a new request, separate from the same-body resend of the 415/compression fallback. */
export function withInferenceRetries<A>(
  request: (isRecovery: boolean) => Effect.Effect<A, DevinFailure>,
  options: { runtime?: InferenceRetryRuntime; onRetry?: (event: InferenceRetryEvent) => Effect.Effect<void> } = {},
): Effect.Effect<A, DevinFailure> {
  const runtime = options.runtime ?? {};
  const random = runtime.random ?? Math.random;
  const wait = runtime.wait ?? ((delayMs: number) => Effect.sleep(Duration.millis(delayMs)));
  return Effect.gen(function* () {
    let lastError: DevinFailure | undefined;
    for (let recovery = 0; recovery < RECOVERY_ATTEMPTS; recovery++) {
      for (let attempt = 0; attempt < CREATION_ATTEMPTS; attempt++) {
        const outcome = yield* Effect.result(request(recovery > 0));
        if (outcome._tag === "Success") return outcome.success;
        const error = outcome.failure;
        if (!canRecover(error)) return yield* Effect.fail(error);
        lastError = error;
        if (!canRetryCreation(error) || attempt + 1 === CREATION_ATTEMPTS) break;
        const delayMs = yield* inferenceRetryDelayMs(attempt, random());
        if (options.onRetry) yield* options.onRetry({ phase: "creation", nextAttempt: attempt + 2, limit: CREATION_ATTEMPTS, delayMs });
        yield* wait(delayMs);
      }
      if (recovery + 1 < RECOVERY_ATTEMPTS && options.onRetry) yield* options.onRetry({ phase: "recovery", nextAttempt: recovery + 2, limit: RECOVERY_ATTEMPTS, delayMs: 0 });
    }
    return yield* Effect.fail(lastError!);
  });
}
