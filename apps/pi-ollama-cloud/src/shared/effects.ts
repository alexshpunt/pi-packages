import { Effect } from "effect";

/** Promise adapters must preserve error identity for HTTP classification and host diagnostics. */
export function fromPromise<A>(evaluate: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: evaluate, catch: (error) => error });
}

export function fromSync<A>(evaluate: () => A): Effect.Effect<A, unknown> {
  return Effect.try({ try: evaluate, catch: (error) => error });
}

/** Cancel this subscription, never the shared operation. The finalizer removes the listener on every exit. */
export function awaitShared<A>(pending: PromiseLike<A>, signal?: AbortSignal): Effect.Effect<A, unknown> {
  return Effect.suspend(() => {
    let onAbort: (() => void) | undefined;
    return Effect.callback<A, unknown>((resume) => {
      if (signal?.aborted) {
        resume(Effect.fail(signal.reason));
        return;
      }
      onAbort = () => resume(Effect.fail(signal?.reason));
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => resume(Effect.succeed(value)),
        (error) => resume(Effect.fail(error)),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (onAbort) signal?.removeEventListener("abort", onAbort);
        }),
      ),
    );
  });
}

/** Keep the caller's AbortSignal.reason at Promise boundaries rather than an Effect interruption wrapper. */
export function runAbortable<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
  return Effect.runPromise(effect, { signal }).catch((error: unknown) => {
    if (signal?.aborted) throw signal.reason;
    throw error;
  });
}
