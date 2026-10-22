import { Context, Effect, Scheduler } from "effect";

/** Effect's process-wide default scheduler, the one `Effect.runFork` and `runPromise` use. */
const defaultScheduler = Context.get(Context.empty(), Scheduler.Scheduler);

/**
 * Runs work that outlives the Pi call that started it on Effect's default scheduler. A fiber forked inside `runSync`, or by a
 * runner captured while `runSync` built the layers, inherits that call's synchronous scheduler, which yields through microtasks:
 * a long burst would then keep timers, I/O and user input waiting until it ends, instead of yielding to them every 2048 operations.
 */
export const onDefaultScheduler = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.Scheduler, defaultScheduler);
