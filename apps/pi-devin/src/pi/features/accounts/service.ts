import { Context, Effect, Layer } from "effect";
import type { Credential, JsonObject } from "../../../core/types.ts";
import { requiredString } from "../../../core/validation.ts";
import { ExtensionConfig } from "../../app/config.ts";
import { AuthState } from "../auth/state.ts";
import { evictOldest } from "../bounded.ts";
import { catalogScope } from "../catalog/projection.ts";
import { DevinClients } from "../clients/service.ts";
import { ProviderLifetime } from "../lifetime/service.ts";
import { UsageStore } from "../settings/service.ts";
import { UsageChanges } from "../usage/changes.ts";
import { accountUsage } from "../usage/report.ts";
import type { AccountUsage } from "../usage/types.ts";
import type { AccountRecord, AccountsShape } from "./types.ts";

/**
 * The only owner of the account status query (`GetUserStatus`): accounts this process verified, by credential scope,
 * and the newest quota they reported. Request checks, the check after sign-in and the periodic session check all go through it.
 */
export class Accounts extends Context.Service<Accounts, AccountsShape>()("pi-devin/Accounts") {}

export const AccountsLive = Layer.effect(Accounts, Effect.gen(function* () {
  const clients = yield* DevinClients;
  const store = yield* UsageStore;
  const changes = yield* UsageChanges;
  const lifetime = yield* ProviderLifetime;
  const auth = yield* AuthState;
  const config = yield* ExtensionConfig;
  const records = new Map<string, AccountRecord>();
  let latestUsage: { scope: string; usage: AccountUsage } | undefined;

  // A stopped provider records nothing more.
  const record = (credential: Credential, ownerHash: string, status: JsonObject) => Effect.gen(function* () {
    if (!(yield* lifetime.isActive)) return;
    const scope = catalogScope(credential);
    evictOldest(records, 16);
    records.set(scope, { ownerHash, status });
    const usage = accountUsage(status, config.now());
    latestUsage = { scope, usage };
    // Subagents and the Fusion sidekick run in other processes; a failed write only loses sharing.
    yield* Effect.ignore(store.write(scope, usage));
    yield* changes.publish;
  });

  return {
    get: (credential) => Effect.sync(() => records.get(catalogScope(credential))),
    check: (credential, check) => Effect.scoped(Effect.gen(function* () {
      const client = yield* clients.open(credential, { profile: "login", ...check.connection });
      const status = yield* client.status();
      if ((yield* auth.generation) !== check.expectedGeneration) return "stale" as const;
      if (check.beforeRecord) yield* check.beforeRecord;
      yield* record(credential, yield* requiredString(yield* client.accountIdentityHash, "Devin account scope"), status);
      return "recorded" as const;
    })),
    forget: (credential) => Effect.sync(() => {
      records.delete(catalogScope(credential));
      latestUsage = undefined;
    }),
    clear: Effect.sync(() => {
      records.clear();
      latestUsage = undefined;
    }),
    usage: (scope) => Effect.map(store.read(scope), (shared) => {
      const local = latestUsage?.scope === scope ? latestUsage.usage : undefined;
      const newest = shared && (!local || shared.fetchedAtMs > local.fetchedAtMs) ? shared : local;
      return newest ? { ...newest } : undefined;
    }),
  } satisfies AccountsShape;
}));
