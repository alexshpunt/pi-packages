import { Context, Effect, Layer } from "effect";
import { isAuthenticationError } from "../../../core/errors.ts";
import { Accounts } from "../accounts/service.ts";
import { Runs } from "../runs/service.ts";
import { UsageChanges } from "../usage/changes.ts";
import { AuthState } from "./state.ts";
import type { CredentialGuardShape } from "./types.ts";

/** Turns a confirmed authentication failure into its consequences, in order and within the reporting effect. */
export class CredentialGuard extends Context.Service<CredentialGuard, CredentialGuardShape>()("pi-devin/CredentialGuard") {}

export const CredentialGuardLive = Layer.effect(CredentialGuard, Effect.gen(function* () {
  const auth = yield* AuthState;
  const accounts = yield* Accounts;
  const runs = yield* Runs;
  const changes = yield* UsageChanges;
  return {
    reportFailure: (credential, error, generation) => Effect.gen(function* () {
      if (!isAuthenticationError(error) || !(yield* auth.markInvalid(credential, error, generation))) return;
      yield* accounts.forget(credential);
      yield* runs.abort(error);
      yield* changes.publish;
    }),
  } satisfies CredentialGuardShape;
}));
