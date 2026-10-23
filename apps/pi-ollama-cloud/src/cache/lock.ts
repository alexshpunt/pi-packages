import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Effect } from "effect";
import lockfile from "proper-lockfile";
import { runAbortable } from "../shared/effects.ts";
import type { CacheLockState } from "./types.ts";

export const CACHE_LOCK_TIMEOUT_MS = 1000;
export const CACHE_LOCK_STALE_MS = 30000;
const RETRY_INTERVAL_MS = 10;
const waitArray = new Int32Array(new SharedArrayBuffer(4));
export interface CacheLockResult {
  ok: boolean;
  state: CacheLockState;
}

function attempt(path: string, action: () => boolean): CacheLockResult | undefined {
  let release: (() => void) | undefined;
  let isCompromised = false;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    release = lockfile.lockSync(path, {
      realpath: false,
      retries: 0,
      stale: CACHE_LOCK_STALE_MS,
      update: CACHE_LOCK_STALE_MS / 2,
      onCompromised: () => {
        isCompromised = true;
      },
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ELOCKED") return undefined;
    return { ok: false, state: "unavailable" };
  }
  let ok = false;
  try {
    // No await is allowed in the read/merge/budget/replace critical section.
    if (!isCompromised) ok = action();
  } finally {
    try {
      release();
    } catch {
      isCompromised = true;
    }
  }
  return { ok: ok && !isCompromised, state: isCompromised ? "compromised" : "ok" };
}

export function withCacheLockSync(
  path: string,
  action: () => boolean,
  timeoutMs = CACHE_LOCK_TIMEOUT_MS,
): CacheLockResult {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const result = attempt(path, action);
    if (result) return result;
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return { ok: false, state: "timeout" };
    Atomics.wait(waitArray, 0, 0, Math.min(RETRY_INTERVAL_MS, remainingMs));
  }
}
export function withCacheLockEffect(
  path: string,
  action: () => boolean,
  signal?: AbortSignal,
  timeoutMs = CACHE_LOCK_TIMEOUT_MS,
): Effect.Effect<CacheLockResult> {
  return Effect.gen(function* () {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const result = attempt(path, action);
      if (result) return result;
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) return { ok: false, state: "timeout" };
      yield* Effect.sleep(Math.min(RETRY_INTERVAL_MS, remainingMs));
    }
  });
}

export function withCacheLock(...args: Parameters<typeof withCacheLockEffect>): Promise<CacheLockResult> {
  return runAbortable(withCacheLockEffect(...args), args[2]);
}
