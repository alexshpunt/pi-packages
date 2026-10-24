import { Data, Effect, Exit, Scope } from "effect";
import { type AnalyticsScope, AnalyticsStore, type RedactionEvent, type RedactionSource } from "./analytics.js";
import type { MaskObservation } from "./engine.js";

export class AnalyticsError extends Data.TaggedError("AnalyticsError")<{
  readonly cause: unknown;
}> {}

interface RecordingContext {
  readonly sessionId: string;
  readonly cwd: string;
}

/** SQLite access and its scope belong to this owner, never to a command or a masking request. */
export function createAnalyticsSession(path: () => string) {
  let store: AnalyticsStore | undefined;
  let scope: Scope.Closeable | undefined;
  let currentSource: RedactionSource | undefined;
  let pendingEvents: RedactionEvent[] = [];

  const connection = Effect.gen(function* () {
    if (store) return store;
    scope ??= yield* Scope.make();
    store = yield* Effect.acquireRelease(
      Effect.try({ try: () => new AnalyticsStore(path()), catch: (cause) => new AnalyticsError({ cause }) }),
      (acquired) => Effect.sync(() => acquired.close()),
    ).pipe(Scope.provide(scope));
    return store;
  });

  function access<A>(operation: (active: AnalyticsStore) => A): Effect.Effect<A, AnalyticsError> {
    return Effect.gen(function* () {
      const active = yield* connection;
      return yield* Effect.try({ try: () => operation(active), catch: (cause) => new AnalyticsError({ cause }) });
    });
  }

  function observe(observation: MaskObservation): void {
    if (currentSource === undefined) return;
    pendingEvents.push({
      source: currentSource,
      label:
        observation.fieldName === undefined ? observation.label : `${observation.label} · ${observation.fieldName}`,
      before: observation.before,
      after: observation.after,
      ruleIds: observation.ruleIds,
    });
  }

  /** Masking stays synchronous. Its observations are flushed on success and failure, without replacing its outcome. */
  function recorded<A, E>(
    source: RedactionSource,
    program: Effect.Effect<A, E>,
    context: () => RecordingContext,
    onFailure: (error: AnalyticsError) => void,
  ): Effect.Effect<A, E> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        currentSource = source;
      }),
      () => program,
      () =>
        Effect.suspend(() => {
          currentSource = undefined;
          const events = pendingEvents;
          pendingEvents = [];
          if (events.length === 0) return Effect.void;
          return access((active) => active.record(context(), events)).pipe(
            Effect.asVoid,
            Effect.catch((error) => Effect.sync(() => onFailure(error))),
          );
        }),
    );
  }

  return {
    observe,
    recorded,
    counts: (sessionId: () => string) =>
      access((active) => ({ session: active.count({ sessionId: sessionId() }), all: active.count({}) })),
    list: (filter: AnalyticsScope, limit: number) => access((active) => active.list(filter, limit)),
    summarize: (filter: AnalyticsScope) => access((active) => active.summarize(filter)),
    get: (id: number) => access((active) => active.get(id)),
    clear: (filter: AnalyticsScope) => access((active) => active.clear(filter)),
    close: Effect.suspend(() => {
      const previous = scope;
      scope = undefined;
      store = undefined;
      return previous ? Scope.close(previous, Exit.void) : Effect.void;
    }),
  };
}

export type AnalyticsSession = ReturnType<typeof createAnalyticsSession>;
