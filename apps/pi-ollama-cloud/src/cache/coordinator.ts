import { createHmac, randomBytes } from "node:crypto";
import { Effect } from "effect";
import { awaitShared, fromPromise, fromSync, runAbortable } from "../shared/effects.ts";

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

/** Each shared job owns its Effect fiber; subscriptions own only their wait and reference count. */
export function createRequestCoordinator<T>() {
  const secret = randomBytes(32);
  const jobs = new Map<string, Job<T>>();
  const resources = new Map<string, { generation: number; active: number }>();
  const digest = (value: unknown) => createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
  function runEffect(
    identity: RequestIdentity,
    work: (context: SharedRequestContext) => Effect.Effect<T, unknown>,
    signal?: AbortSignal,
  ): Effect.Effect<T, unknown> {
    return Effect.suspend(() => {
      if (signal?.aborted) return Effect.fail(signal.reason);
      const resourceKey = digest([identity.key, identity.credential]);
      const key = digest([resourceKey, Boolean(identity.refresh)]);
      let job = jobs.get(key);
      if (!job) {
        const resource = resources.get(resourceKey) ?? { generation: 0, active: 0 };
        resources.set(resourceKey, resource);
        const generation = ++resource.generation;
        resource.active += 1;
        const controller = new AbortController();
        let hasRemoved = false;
        const created: Job<T> = {
          controller,
          waiters: 0,
          hasSettled: false,
          // Preserve the existing microtask boundary: register ownership before starting external work.
          promise: Promise.resolve().then(() =>
            runAbortable(
              Effect.gen(function* () {
                yield* fromSync(() => controller.signal.throwIfAborted());
                return yield* work({
                  signal: controller.signal,
                  canPublish: () =>
                    !controller.signal.aborted && !created.hasSettled && resource.generation === generation,
                });
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    created.hasSettled = true;
                    remove();
                  }),
                ),
              ),
              controller.signal,
            ),
          ),
        };
        function remove() {
          if (hasRemoved) return;
          hasRemoved = true;
          controller.signal.removeEventListener("abort", remove);
          if (jobs.get(key) === created) jobs.delete(key);
          resource.active -= 1;
          if (resource.active === 0 && resources.get(resourceKey) === resource) resources.delete(resourceKey);
        }
        controller.signal.addEventListener("abort", remove, { once: true });
        // An orphaned failure is observed even when every subscriber cancels.
        void created.promise.catch(() => {});
        jobs.set(key, created);
        job = created;
      }
      const shared = job;
      shared.waiters += 1;
      return awaitShared(shared.promise, signal).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            shared.waiters -= 1;
            if (shared.waiters === 0 && !shared.hasSettled) shared.controller.abort();
          }),
        ),
      );
    });
  }
  return {
    runEffect,
    run: (identity: RequestIdentity, work: (context: SharedRequestContext) => Promise<T>, signal?: AbortSignal) =>
      Effect.runPromise(runEffect(identity, (context) => fromPromise(() => work(context)), signal)),
    getDiagnostics: () => ({ inFlight: jobs.size, resources: resources.size }),
  };
}

export function createScopedEffectCoordinator<T>() {
  const caches = new WeakMap<object, WeakMap<object, ReturnType<typeof createRequestCoordinator<T>>>>();
  return (
    cache: object,
    authScope: object,
    identity: RequestIdentity,
    work: (context: SharedRequestContext) => Effect.Effect<T, unknown>,
    signal?: AbortSignal,
  ) =>
    Effect.suspend(() => {
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
      return coordinator.runEffect(identity, work, signal);
    });
}

export function createScopedCoordinator<T>() {
  const run = createScopedEffectCoordinator<T>();
  return (
    cache: object,
    authScope: object,
    identity: RequestIdentity,
    work: (context: SharedRequestContext) => Promise<T>,
    signal?: AbortSignal,
  ) => Effect.runPromise(run(cache, authScope, identity, (context) => fromPromise(() => work(context)), signal));
}
