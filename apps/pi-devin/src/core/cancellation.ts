import { Deferred, Duration, Effect, Exit, type Scope } from "effect";
import { RequestTimeout, toDevinFailure, type DevinFailure } from "./errors.ts";

/**
 * A one-shot stop switch that carries its reason. Interruption has no reason, so lifetimes such as a closed client,
 * an invalidated login or an ended run fail the guarded work with the reason instead.
 */
export interface Cancellation {
  /** Fails with the reason once cancelled; never succeeds. */
  readonly await: Effect.Effect<never, DevinFailure>;
  readonly isCancelled: () => boolean;
  readonly reason: () => DevinFailure | undefined;
  /** Cancels once; later reasons are ignored. Also usable from synchronous host callbacks. */
  readonly cancelUnsafe: (reason: DevinFailure) => void;
  readonly cancel: (reason: DevinFailure) => Effect.Effect<void>;
  /** Stops the effect when cancelled and fails it with the reason. Already cancelled work does not start. */
  readonly guard: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | DevinFailure, R>;
}

export function makeCancellation(): Cancellation {
  const deferred = Deferred.makeUnsafe<never, DevinFailure>();
  let current: DevinFailure | undefined;
  const cancelUnsafe = (reason: DevinFailure) => {
    if (current) return;
    current = reason;
    Deferred.doneUnsafe(deferred, Exit.fail(reason));
  };
  return {
    await: Deferred.await(deferred),
    isCancelled: () => current !== undefined,
    reason: () => current,
    cancelUnsafe,
    cancel: (reason) => Effect.sync(() => cancelUnsafe(reason)),
    guard: (effect) => Effect.suspend(() => current ? Effect.fail(current) : Effect.raceFirst(effect, Deferred.await(deferred))),
  };
}

/** Guards an effect with several cancellations; the first one wins. */
export function guardAll(cancellations: readonly Cancellation[]) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | DevinFailure, R> =>
    cancellations.reduce<Effect.Effect<A, E | DevinFailure, R>>((guarded, cancellation) => cancellation.guard(guarded), effect);
}

/**
 * Starts a deadline at once. The timer is registered before the guarded work runs any of its own code,
 * so hooks that advance or block time cannot slip past it. The timer stops with the scope.
 */
export function startDeadline(timeoutMs: number, reason: () => DevinFailure = () => new RequestTimeout({ message: `The request exceeded the ${timeoutMs}ms timeout.` })): Effect.Effect<Cancellation, never, Scope.Scope> {
  return Effect.gen(function* () {
    const deadline = makeCancellation();
    yield* Effect.forkScoped(Effect.sleep(Duration.millis(timeoutMs)).pipe(Effect.andThen(deadline.cancel(reason()))), { startImmediately: true });
    return deadline;
  });
}

/** Fails with the signal's reason once it aborts; never succeeds. */
export function whenAborted(signal: AbortSignal): Effect.Effect<never, DevinFailure> {
  return Effect.callback<never, DevinFailure>((resume) => {
    const onAbort = () => resume(Effect.fail(toDevinFailure(signal.reason)));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Bridges a host `AbortSignal`: the effect stops when it aborts and fails with the signal's reason,
 * because hosts tell cancellation from a timeout by that reason.
 */
export function abortWith(signal: AbortSignal | undefined) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | DevinFailure, R> => {
    if (!signal) return effect;
    return Effect.suspend(() => signal.aborted ? Effect.fail(toDevinFailure(signal.reason)) : Effect.raceFirst(effect, whenAborted(signal)));
  };
}
