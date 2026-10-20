import { createHmac, randomBytes } from "node:crypto";

export interface RequestIdentity {
  key: string;
  credential: string;
  refresh?: boolean;
}
export interface SharedRequestContext {
  signal: AbortSignal;
  canPublish: () => boolean;
}
interface Job<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
  hasSettled: boolean;
}

export function createRequestCoordinator<T>() {
  const secret = randomBytes(32);
  const jobs = new Map<string, Job<T>>();
  const resources = new Map<string, { generation: number; active: number }>();
  const digest = (value: unknown) => createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
  function run(
    identity: RequestIdentity,
    work: (context: SharedRequestContext) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const resourceKey = digest([identity.key, identity.credential]);
    const key = digest([resourceKey, Boolean(identity.refresh)]);
    let job = jobs.get(key);
    if (!job) {
      const resource = resources.get(resourceKey) ?? { generation: 0, active: 0 };
      resources.set(resourceKey, resource);
      const generation = ++resource.generation;
      resource.active += 1;
      const controller = new AbortController();
      const created: Job<T> = {
        controller,
        waiters: 0,
        hasSettled: false,
        promise: Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted();
            return work({
              signal: controller.signal,
              canPublish: () => !controller.signal.aborted && !created.hasSettled && resource.generation === generation,
            });
          })
          .finally(() => {
            created.hasSettled = true;
            remove();
          }),
      };
      let hasRemoved = false;
      function remove() {
        if (hasRemoved) return;
        hasRemoved = true;
        if (jobs.get(key) === created) jobs.delete(key);
        resource.active -= 1;
        if (resource.active === 0 && resources.get(resourceKey) === resource) resources.delete(resourceKey);
      }
      controller.signal.addEventListener("abort", remove, { once: true });
      // All waiters may cancel before an abort-ignoring transport rejects. Observe that orphan only.
      void created.promise.catch(() => {});
      jobs.set(key, created);
      job = created;
    }
    const shared = job;
    shared.waiters += 1;
    return new Promise<T>((resolve, reject) => {
      let isWaiting = true;
      function release() {
        isWaiting = false;
        signal?.removeEventListener("abort", cancel);
        shared.waiters -= 1;
        if (shared.waiters === 0 && !shared.hasSettled) shared.controller.abort();
      }
      function cancel() {
        if (!isWaiting) return;
        release();
        reject(signal?.reason);
      }
      signal?.addEventListener("abort", cancel, { once: true });
      shared.promise.then(
        (value) => {
          if (isWaiting) {
            release();
            resolve(value);
          }
        },
        (error: unknown) => {
          if (isWaiting) {
            release();
            reject(error);
          }
        },
      );
    });
  }
  return { run, getDiagnostics: () => ({ inFlight: jobs.size, resources: resources.size }) };
}
export function createScopedCoordinator<T>() {
  const caches = new WeakMap<object, WeakMap<object, ReturnType<typeof createRequestCoordinator<T>>>>();
  return (
    cache: object,
    authScope: object,
    identity: RequestIdentity,
    work: (context: SharedRequestContext) => Promise<T>,
    signal?: AbortSignal,
  ) => {
    let scopes = caches.get(cache);
    if (!scopes) {
      scopes = new WeakMap();
      caches.set(cache, scopes);
    }
    let coordinator = scopes.get(authScope);
    if (!coordinator) {
      coordinator = createRequestCoordinator<T>();
      scopes.set(authScope, coordinator);
    }
    return coordinator.run(identity, work, signal);
  };
}
