import type { Effect, Scope } from "effect";
import type { DevinClient, MetadataProfile } from "../../../core/client.ts";
import type { DevinError } from "../../../core/errors.ts";
import type { ConnectClientOptions } from "../../../core/protocol/connect-client.ts";
import type { Credential } from "../../../core/types.ts";

export interface ClientOptions {
  profile?: MetadataProfile;
  /** Pi's per-request fetch. Replaces the provider's transport for this client only. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  onRequest?: ConnectClientOptions["onRequest"];
}

export interface DevinClientsShape {
  /** A client for the calling scope. Shares the credential's device fingerprint and closes with the scope. */
  readonly open: (credential: Credential, options?: ClientOptions) => Effect.Effect<DevinClient, DevinError, Scope.Scope>;
  /** Closes every open client; their in-flight requests fail as closed. */
  readonly closeAll: Effect.Effect<void>;
  /** Forgets the per-credential fingerprints, so later clients collect device values again. */
  readonly clearFingerprints: Effect.Effect<void>;
}
