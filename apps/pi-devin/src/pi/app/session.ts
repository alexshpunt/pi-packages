import { Effect } from "effect";
import { Cancelled } from "../../core/errors.ts";
import { Accounts } from "../features/accounts/service.ts";
import { DevinClients } from "../features/clients/service.ts";
import { ProviderLifetime } from "../features/lifetime/service.ts";
import { Runs } from "../features/runs/service.ts";
import type { SessionBinding } from "../features/runs/types.ts";

/** Binds the provider to Pi's current session: a new provider lifetime if the last one ended, then the session's stored run state. Fails on a corrupt state. */
export const attachSession = (binding: SessionBinding) => Effect.gen(function* () {
  yield* (yield* ProviderLifetime).renew;
  yield* (yield* Runs).attach(binding);
});

/**
 * Stops the provider's work. The lifetime ends first, so running requests stop with its reason rather than an interruption;
 * an unfinished run stays in the session's checkpoint. The extension instance and its runtime stay usable.
 */
export const shutdownProvider = Effect.gen(function* () {
  const clients = yield* DevinClients;
  yield* (yield* ProviderLifetime).end(new Cancelled({ message: "The Devin provider shut down." }));
  yield* (yield* Runs).shutdown;
  yield* clients.closeAll;
  yield* clients.clearFingerprints;
  yield* (yield* Accounts).clear;
});
