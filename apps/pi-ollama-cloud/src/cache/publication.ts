import type { CacheData, CacheStore } from "./types.ts";

/** Preserve legacy synchronous injected stores; the default store waits asynchronously for its file lock. */
export async function publishCache(
  store: CacheStore,
  mutation: (data: CacheData) => void,
  signal?: AbortSignal,
  canPublish: () => boolean = () => true,
): Promise<void> {
  signal?.throwIfAborted();
  if (!canPublish()) return;
  if (store.updateCache) {
    await store.updateCache((data) => {
      if (canPublish()) mutation(data);
    }, signal);
  } else {
    mutation(store.loadCache());
    store.saveCache();
  }
}
