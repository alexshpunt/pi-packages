import { Effect } from "effect";

/** Preserve the original error instead of exposing Effect's UnknownError text. */
export function fromPromise<A>(evaluate: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A, unknown> {
	return Effect.tryPromise({ try: evaluate, catch: (error) => error });
}

export function fromSync<A>(evaluate: () => A): Effect.Effect<A, unknown> {
	return Effect.try({ try: evaluate, catch: (error) => error });
}
