import { Context, Effect, Layer } from "effect";
import type { UsageChangesShape } from "./types.ts";

/**
 * Change notices for displays such as the status line. Owners of account records and the current credential publish;
 * listeners run synchronously inside the publishing effect, so a redraw sees the state that caused it.
 */
export class UsageChanges extends Context.Service<UsageChanges, UsageChangesShape>()("pi-devin/UsageChanges") {}

export const UsageChangesLive = Layer.sync(UsageChanges, () => {
  const listeners = new Set<{ readonly listener: Effect.Effect<void> }>();
  return {
    // A display failure must not affect requests or refreshes.
    publish: Effect.suspend(() => Effect.forEach([...listeners], (entry) => Effect.catchCause(entry.listener, () => Effect.void), { discard: true })),
    subscribe: (listener) => Effect.asVoid(Effect.acquireRelease(
      Effect.sync(() => { const entry = { listener }; listeners.add(entry); return entry; }),
      (entry) => Effect.sync(() => { listeners.delete(entry); }),
    )),
  } satisfies UsageChangesShape;
});
