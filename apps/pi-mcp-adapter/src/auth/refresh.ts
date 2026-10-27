/**
 * OAuth for MCP connections. Connections never start a browser flow on their own: they send the stored
 * access token and, after a 401, try the stored refresh token. When that is not possible they fail with
 * `McpOAuthAuthorizationRequiredError`, and the user signs in through `/mcp` (sign-in.ts).
 */

import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import {
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  type OAuthChallenge,
  parseWwwAuthenticate,
} from "@earendil-works/pi-mcp/oauth";
import { Effect } from "effect";
import { fromPromise, fromSync, makeSingleFlight } from "../shared/effects.ts";
import {
  callbackSettings,
  createProvider,
  FALLBACK_REDIRECT_URL,
  type McpOAuthSettings,
  registeredRedirectUrls,
  timedFetch,
} from "./oauth-client.ts";
import type { McpOAuthServerStore } from "./store.ts";

/** Access tokens this close to expiry are refreshed before they are sent. */
const REFRESH_SKEW_MS = 30_000;

export interface McpAuthProvider extends AuthProvider {
  /** Completes when no refresh is running, so shutdown does not drop rotated tokens before they are saved. */
  readonly settled: Effect.Effect<void>;
}

/**
 * Auth provider for MCP connections: sends the stored access token and refreshes it when it is about
 * to expire or after a 401. Fails with `McpOAuthAuthorizationRequiredError` when the user has to sign in,
 * including when the server asks for more scope (`insufficient_scope`). `onChallenge` receives the
 * server's `WWW-Authenticate` challenge so sign-in can use its resource metadata URL and scope.
 * `settings` is only called when a refresh is needed, so a secret that fails to resolve fails the
 * refresh instead of the whole connection setup.
 *
 * Many servers rotate refresh tokens, so two refreshes with the same refresh token lose the grant.
 * Requests in this process share one refresh, and other processes are kept out by the store's
 * refresh lock, held from reading the tokens to saving new ones. Tokens that changed meanwhile
 * (another process refreshed them, or the user signed in) are used without refreshing.
 */
export function createMcpAuthProvider(options: {
  serverUrl: string;
  store: McpOAuthServerStore;
  settings: () => McpOAuthSettings;
  onChallenge: (challenge: OAuthChallenge) => void;
}): McpAuthProvider {
  const { serverUrl, store } = options;
  const refreshing = makeSingleFlight<void, unknown>();
  const loadState = fromPromise(async () => store.load());

  /** Replace `staleToken`, the access token that expired or was rejected. */
  const refresh = (staleToken: string | undefined, fetch: McpFetch = globalThis.fetch, challenge?: OAuthChallenge) =>
    refreshing.run(
      store
        .withRefreshLock(
          Effect.gen(function* () {
            const state = yield* loadState;
            if (state?.tokens?.access_token !== staleToken) return;
            if (!state?.tokens?.refresh_token) return yield* Effect.fail(new McpOAuthAuthorizationRequiredError());
            const settings = yield* fromSync(options.settings);
            const redirectUrl =
              callbackSettings(settings).fixedRedirectUrl ??
              registeredRedirectUrls(state.clientInformation)[0] ??
              FALLBACK_REDIRECT_URL;
            const provider = createProvider(serverUrl, store, settings, redirectUrl, () => {});
            // Refreshes the tokens, or reports that a new sign-in is needed.
            const result = yield* fromPromise(() =>
              authorizeMcp(provider, {
                serverUrl,
                resourceMetadataUrl: challenge?.resourceMetadataUrl,
                authorizationServerMetadataUrl: settings.authServerMetadataUrl,
                scope: challenge?.scope,
                fetch: timedFetch(fetch),
              }),
            );
            if (result === "REDIRECT") return yield* Effect.fail(new McpOAuthAuthorizationRequiredError());
          }),
        )
        // Not cancellable: a refresh the server answered may have rotated the refresh token, so its
        // answer must be saved.
        .pipe(Effect.uninterruptible),
    );

  return {
    // pi-mcp calls these and waits for their promises.
    token: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* refreshing.settled;
          const state = yield* loadState;
          const token = state?.tokens?.access_token;
          const isExpired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
          if (!isExpired || !state?.tokens?.refresh_token) return token;
          // Failures fall through: the request goes out with the old token and a 401 decides what happens.
          yield* Effect.ignore(refresh(token));
          return (yield* loadState)?.tokens?.access_token;
        }),
      ),
    onUnauthorized: (context) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
          options.onChallenge(challenge);
          // A refresh keeps the granted scope, so more scope needs a new sign-in.
          if (challenge.error === "insufficient_scope") {
            return yield* Effect.fail(new McpOAuthAuthorizationRequiredError());
          }
          yield* refresh(context.token, context.fetch, challenge);
        }),
      ),
    settled: refreshing.settled,
  };
}
