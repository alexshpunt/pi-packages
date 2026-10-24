import { createRedactor } from "@buyong/redact";
import { Data, Effect, Ref } from "effect";
import { TextCache } from "./cache.js";
import { createMaskEngine, type MaskEngine, type MaskObservation } from "./engine.js";
import type { LoadedSettings } from "./settings.js";

/** Bounds stay in characters, not bytes, matching TextCache's accounting. */
const REQUEST_CACHE_CHARACTERS = 8 * 1024 * 1024;
const REQUEST_CACHE_ENTRIES = 50_000;

export interface MaskPreview {
  readonly masked: string;
  readonly ruleIds: readonly string[];
}

export interface MaskingStatus {
  readonly isEnabled: boolean;
  readonly sessionChoice: boolean | undefined;
  readonly isEnabledByDefault: boolean;
  readonly sources: readonly string[];
  readonly problems: readonly string[];
  readonly disabledRules: readonly string[];
}

export class MaskingError extends Data.TaggedError("MaskingError")<{
  readonly cause: unknown;
}> {}

interface MaskingState {
  readonly settings: LoadedSettings;
  readonly sessionChoice: boolean | undefined;
  readonly stored: MaskEngine;
  readonly requests: MaskEngine;
}

/** A session owns its effective rules and cache; callers get operations, never the mutable state. */
export function makeMaskingSession(observe: (observation: MaskObservation) => void) {
  return Effect.gen(function* () {
    function configured(settings: LoadedSettings, sessionChoice: boolean | undefined): MaskingState {
      const options = { disabledRules: settings.disabledRules, observe };
      return {
        settings,
        sessionChoice,
        stored: createMaskEngine(settings.redactor, undefined, options),
        requests: createMaskEngine(
          settings.redactor,
          new TextCache(REQUEST_CACHE_CHARACTERS, REQUEST_CACHE_ENTRIES),
          options,
        ),
      };
    }

    const state = yield* Ref.make(
      configured(
        { redactor: createRedactor(), disabledRules: [], isEnabledByDefault: true, sources: [], problems: [] },
        undefined,
      ),
    );
    const snapshot = Ref.get(state).pipe(
      Effect.map(
        ({ settings, sessionChoice }): MaskingStatus => ({
          isEnabled: sessionChoice ?? settings.isEnabledByDefault,
          sessionChoice,
          isEnabledByDefault: settings.isEnabledByDefault,
          sources: settings.sources,
          problems: settings.problems,
          disabledRules: settings.disabledRules,
        }),
      ),
    );

    function mask<A>(
      kind: "stored" | "requests",
      operation: (engine: MaskEngine) => A,
    ): Effect.Effect<A, MaskingError> {
      return Effect.gen(function* () {
        const current = yield* Ref.get(state);
        return yield* Effect.try({
          try: () => operation(current[kind]),
          catch: (cause) => new MaskingError({ cause }),
        });
      });
    }

    return {
      snapshot,
      isEnabled: snapshot.pipe(Effect.map((status) => status.isEnabled)),
      setSessionChoice: (sessionChoice: boolean | undefined) =>
        Ref.update(state, (current) => ({ ...current, sessionChoice })),
      // A new ruleset and both engines are published in one state update; old cached results cannot survive it.
      configure: (settings: LoadedSettings) =>
        Ref.update(state, (current) => configured(settings, current.sessionChoice)),
      stored: <A>(operation: (engine: MaskEngine) => A) => mask("stored", operation),
      requests: <A>(operation: (engine: MaskEngine) => A) => mask("requests", operation),
      preview: (text: string): Effect.Effect<MaskPreview, MaskingError> =>
        Effect.gen(function* () {
          const { settings } = yield* Ref.get(state);
          return yield* Effect.try({
            try: () => {
              const ruleIds = new Set<string>();
              const engine = createMaskEngine(settings.redactor, undefined, {
                disabledRules: settings.disabledRules,
                observe: (observation) => {
                  for (const ruleId of observation.ruleIds) ruleIds.add(ruleId);
                },
              });
              return { masked: engine.maskText(text), ruleIds: [...ruleIds] };
            },
            catch: (cause) => new MaskingError({ cause }),
          });
        }),
    };
  });
}

export type MaskingSession = Effect.Success<ReturnType<typeof makeMaskingSession>>;
