import type { AuthInteraction, ModelAuth, OAuthCredential } from "@earendil-works/pi-ai";
import type { Effect } from "effect";
import type { DevinError, DevinFailure, RPCError } from "../../../core/errors.ts";
import type { Credential } from "../../../core/types.ts";

export interface AuthStateShape {
  /** Increases with every successful sign-in. Work captures it when it starts and acts on failures only within the same generation. */
  readonly generation: Effect.Effect<number>;
  /** Fails with an authentication error when this credential was invalidated. */
  readonly assertUsable: (credential: Credential) => Effect.Effect<void, RPCError>;
  /** Rejects sessions that did not come from an OAuth login or stored credential (API keys etc.) before any network request. */
  readonly assertOAuthSession: (credential: Credential) => Effect.Effect<void, DevinError>;
  /** Remembers the credential as this process's OAuth session. Pi resolves the session in use on every request, so it moves back to the front. */
  readonly rememberOAuth: (credential: Credential) => Effect.Effect<Credential>;
  /** Converts the OAuth credential stored by Pi into the shared credential and remembers it as an OAuth session. */
  readonly fromHost: (credential: OAuthCredential) => Effect.Effect<Credential, DevinError>;
  /** Marks a confirmed authentication failure of the given generation. True only when this call invalidated the credential. */
  readonly markInvalid: (credential: Credential, error: unknown, generation: number) => Effect.Effect<boolean>;
  /** A new sign-in: clears its invalid mark, remembers it and starts the next generation, which it returns. */
  readonly acceptLogin: (credential: Credential) => Effect.Effect<number>;
}

export interface CredentialGuardShape {
  /**
   * Acts on a failure seen while using the credential. Only a confirmed authentication failure of the current generation
   * invalidates it; then its account record is forgotten and the running run stops with the same error. The credential file is never deleted.
   */
  readonly reportFailure: (credential: Credential, error: unknown, generation: number) => Effect.Effect<void>;
}

/** Pi's OAuth flows. Each call stops with the provider lifetime current when it started and with the caller's signal. */
export interface AccountLoginShape {
  readonly login: (interaction: AuthInteraction) => Effect.Effect<OAuthCredential, DevinFailure>;
  readonly refresh: (current: OAuthCredential, signal: AbortSignal) => Effect.Effect<OAuthCredential, DevinFailure>;
  readonly toAuth: (current: OAuthCredential) => Effect.Effect<ModelAuth, DevinError | RPCError>;
}
