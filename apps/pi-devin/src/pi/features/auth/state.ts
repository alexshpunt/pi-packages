import { Context, Effect, Layer } from "effect";
import { isAuthenticationError, RPCError } from "../../../core/errors.ts";
import type { Credential } from "../../../core/types.ts";
import { failWith } from "../../../core/validation.ts";
import { evictOldest } from "../bounded.ts";
import { credentialFromOAuth, credentialKey, OAUTH_ONLY_MESSAGE, sessionKey } from "./credential.ts";
import type { AuthStateShape } from "./types.ts";

/**
 * Whether a credential may be used: the sign-in generation, credentials invalidated by a confirmed 401,
 * and the OAuth sessions this process has seen. Remembers only hashes, never a token.
 */
export class AuthState extends Context.Service<AuthState, AuthStateShape>()("pi-devin/AuthState") {}

export const AuthStateLive = Layer.sync(AuthState, () => {
  const invalid = new Set<string>();
  const oauthSessions = new Set<string>();
  let generation = 0;
  const rememberOAuth = (credential: Credential) => Effect.sync(() => {
    const key = sessionKey(credential);
    oauthSessions.delete(key);
    evictOldest(oauthSessions, 64);
    oauthSessions.add(key);
    return credential;
  });
  return {
    generation: Effect.sync(() => generation),
    assertUsable: (credential) => Effect.suspend(() => invalid.has(credentialKey(credential))
      ? Effect.fail(RPCError.make("unauthenticated", "Authentication failed for this session. Sign in again with /login.")) : Effect.void),
    // Kept as a plain error so it does not invalidate authentication or cancel a running request.
    assertOAuthSession: (credential) => Effect.suspend(() => oauthSessions.has(sessionKey(credential)) ? Effect.void : failWith(OAUTH_ONLY_MESSAGE)),
    rememberOAuth,
    fromHost: (credential) => Effect.flatMap(credentialFromOAuth(credential), rememberOAuth),
    markInvalid: (credential, error, expectedGeneration) => Effect.sync(() => {
      if (expectedGeneration !== generation || !isAuthenticationError(error)) return false;
      const key = credentialKey(credential);
      if (invalid.has(key)) return false;
      evictOldest(invalid, 64);
      invalid.add(key);
      return true;
    }),
    acceptLogin: (credential) => Effect.gen(function* () {
      invalid.delete(credentialKey(credential));
      yield* rememberOAuth(credential);
      return ++generation;
    }),
  } satisfies AuthStateShape;
});
