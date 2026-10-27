import { Effect } from "effect";
import { fromPromise } from "./effects.ts";

export function concurrentMapEffect<T, R>(
  items: T[],
  workers: number,
  fn: (item: T) => Promise<R>,
): Effect.Effect<PromiseSettledResult<R>[]> {
  return Effect.forEach(
    items,
    (item) =>
      fromPromise(() => fn(item)).pipe(
        Effect.match({
          onSuccess: (value): PromiseSettledResult<R> => ({ status: "fulfilled", value }),
          onFailure: (reason): PromiseSettledResult<R> => ({ status: "rejected", reason }),
        }),
      ),
    { concurrency: Math.max(1, Math.trunc(workers)) },
  );
}

export function concurrentMap<T, R>(
  items: T[],
  workers: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return Effect.runPromise(concurrentMapEffect(items, workers, fn));
}
