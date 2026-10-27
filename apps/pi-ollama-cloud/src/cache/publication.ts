import { Effect } from "effect";
import { fromPromise } from "../shared/effects.ts";
import type { CacheData, CacheStore } from "./types.ts";

/** Preserve legacy synchronous injected stores; the default store waits asynchronously for its file lock. */
export function publishCacheEffect(
  store: CacheStore,
  mutation: (data: CacheData) => void,
  signal?: AbortSignal,
  canPublish: () => boolean = () => true,
) {
  return Effect.gen(function* () {
    signal?.throwIfAborted();
    if (!canPublish()) return;
    if (store.updateCache) {
      yield* fromPromise(() =>
        store.updateCache!((data) => {
          if (canPublish()) mutation(data);
        }, signal),
      );
    } else {
      mutation(store.loadCache());
      store.saveCache();
    }
  });
}

export function publishCache(...args: Parameters<typeof publishCacheEffect>): Promise<void> {
  return Effect.runPromise(publishCacheEffect(...args));
}
