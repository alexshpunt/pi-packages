/**
 * Effect adapters for the Promise and AbortSignal APIs of the MCP client, Node, and Pi. They keep the
 * original error objects, since their messages reach the model and the user unchanged.
 */

import { Deferred, Effect } from "effect";

/** A Promise as an Effect that fails with the rejection reason itself. */
export function fromPromise<A>(evaluate: () => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: evaluate, catch: (error) => error });
}

/** A synchronous call as an Effect that fails with the thrown value itself. */
export function fromSync<A>(evaluate: () => A): Effect.Effect<A, unknown> {
  return Effect.try({ try: evaluate, catch: (error) => error });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Completes when `signal` aborts, at once when it already did, and never without a signal. */
export function whenAborted(signal: AbortSignal | undefined): Effect.Effect<void> {
  if (!signal) return Effect.never;
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

/** One run of a shared operation, such as opening a connection, that concurrent callers wait for together. */
export interface SingleFlight<A, E> {
  /** Wait for the running operation, or start `work` when none runs. */
  run(work: Effect.Effect<A, E>): Effect.Effect<A, E>;
  /** Completes once no operation runs. The operation's failure is ignored. */
  readonly settled: Effect.Effect<void>;
}

/** The run is forgotten once it settles, so the next `run` starts the work again. */
export function makeSingleFlight<A, E>(): SingleFlight<A, E> {
  let current: Deferred.Deferred<A, E> | undefined;
  return {
    run: (work) =>
      Effect.suspend(() => {
        if (current) return Deferred.await(current);
        const deferred = Deferred.makeUnsafe<A, E>();
        current = deferred;
        return work.pipe(
          Effect.onExit((exit) =>
            Effect.suspend(() => {
              if (current === deferred) current = undefined;
              return Deferred.done(deferred, exit);
            }),
          ),
        );
      }),
    settled: Effect.suspend(() => (current ? Effect.ignore(Deferred.await(current)) : Effect.void)),
  };
}
