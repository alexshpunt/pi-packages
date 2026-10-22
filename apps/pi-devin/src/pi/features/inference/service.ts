import { Context, Effect, FiberSet, Layer } from "effect";
import { Accounts } from "../accounts/service.ts";
import { CredentialGuard } from "../auth/guard.ts";
import { AuthState } from "../auth/state.ts";
import { ModelCatalog } from "../catalog/service.ts";
import { DevinClients } from "../clients/service.ts";
import { onDefaultScheduler } from "../default-scheduler.ts";
import { ProviderLifetime } from "../lifetime/service.ts";
import { Runs } from "../runs/service.ts";
import { prepareRequest, type InferenceDependencies } from "./request.ts";
import type { InferenceShape } from "./types.ts";

/**
 * Devin requests behind Pi's provider calls. Each request owns its scope (lease, request client) and runs in a fiber of this
 * service, so it outlives the synchronous provider call that returned its stream. It stops through its own guards, never by Pi returning.
 */
export class Inference extends Context.Service<Inference, InferenceShape>()("pi-devin/Inference") {}

export const InferenceLive = Layer.effect(Inference, Effect.gen(function* () {
  const deps: InferenceDependencies = {
    auth: yield* AuthState, guard: yield* CredentialGuard, catalog: yield* ModelCatalog, accounts: yield* Accounts,
    clients: yield* DevinClients, runs: yield* Runs, lifetime: yield* ProviderLifetime,
  };
  const requests = yield* FiberSet.make<void, never>();
  return {
    start: (model, context, options) => Effect.gen(function* () {
      const request = yield* prepareRequest(deps, model, context, options);
      // Starts at once, as the previous synchronous prefix did: validation failures reach the stream before the call returns.
      yield* FiberSet.run(requests, onDefaultScheduler(request.run), { startImmediately: true });
      return request.stream;
    }),
  } satisfies InferenceShape;
}));
