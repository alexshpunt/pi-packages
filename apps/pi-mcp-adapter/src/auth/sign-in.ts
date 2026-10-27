/**
 * OAuth sign-in to remote MCP servers, which the user starts with `/mcp`: the authorization code flow
 * (PKCE, a Client ID Metadata Document or dynamic client registration) against a loopback callback.
 * Tokens are saved to the server's store (store.ts).
 */

import {
  authorizeMcp,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthCallback,
  type OAuthCallbackPage,
  OAuthCallbackServer,
  type OAuthChallenge,
  stepUpScope,
} from "@earendil-works/pi-mcp/oauth";
import { Data, Effect } from "effect";
import { fromPromise } from "../shared/effects.ts";
import {
  CALLBACK_PATH,
  type CallbackSettings,
  callbackId,
  callbackSettings,
  createProvider,
  type McpOAuthSettings,
  registeredRedirectUrls,
  timedFetch,
} from "./oauth-client.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./page.ts";

export interface McpSignInPrompt {
  /** Show the authorization URL to the user and open it in a browser. */
  showAuthorizationUrl(url: URL): void;
  /**
   * Ask for the redirect URL from the browser address bar, for when the browser cannot reach the
   * loopback callback (for example over SSH). Aborted once the callback arrives or the sign-in is
   * cancelled. Succeeds with `undefined` or an empty string when the user cancels.
   */
  promptForRedirectUrl(signal: AbortSignal): Effect.Effect<string | undefined, unknown>;
}

export class SignInCancelled extends Data.TaggedError("SignInCancelled")<{ readonly message: string }> {
  constructor() {
    super({ message: "Sign-in cancelled" });
  }
}

/** Scopes of both lists, each once. */
function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
  const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
  return merged.length > 0 ? merged.join(" ") : undefined;
}

type AuthorizationResponse = Pick<OAuthCallback, "code" | "iss">;

function responseFromRedirectUrl(input: string, state: string, redirectUrl: URL): AuthorizationResponse {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Expected the full redirect URL from the browser address bar");
  }
  // A server-specific redirect URI tells authorization servers apart, so it must match exactly.
  if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname) {
    throw new Error("The redirect URL does not match this sign-in's redirect URI");
  }
  const error = url.searchParams.get("error");
  if (error) throw new Error(url.searchParams.get("error_description") ?? error);
  if (url.searchParams.get("state") !== state) throw new Error("The redirect URL belongs to a different sign-in");
  const code = url.searchParams.get("code");
  if (!code) throw new Error("The redirect URL does not contain an authorization code");
  return { code, iss: url.searchParams.get("iss") ?? undefined };
}

/**
 * Wait for the browser callback or a pasted redirect URL, whichever settles first. Aborting `signal`
 * aborts the prompt, which then cancels the sign-in.
 */
function waitForAuthorizationResponse(
  callback: OAuthCallbackServer,
  state: string,
  redirectUrl: URL,
  prompt: McpSignInPrompt,
  signal: AbortSignal | undefined,
): Effect.Effect<AuthorizationResponse, unknown> {
  return Effect.suspend(() => {
    const controller = new AbortController();
    const promptSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const fromBrowser = callback.waitForCallback(state, redirectUrl.pathname);
    // The losing side fails once the prompt is aborted or the callback server closes.
    fromBrowser.catch(() => undefined);
    const fromUser = Effect.flatMap(prompt.promptForRedirectUrl(promptSignal), (input) =>
      input?.trim()
        ? Effect.try({ try: () => responseFromRedirectUrl(input, state, redirectUrl), catch: (error) => error })
        : Effect.fail(new SignInCancelled()),
    );
    return Effect.raceFirst(
      fromPromise(() => fromBrowser),
      fromUser,
    ).pipe(Effect.ensuring(Effect.sync(() => controller.abort())));
  });
}

/** Listen on `port`, or on a free port when it is taken and not required. */
function listenForCallback(
  settings: CallbackSettings,
  extraPaths: string[],
  port: number | undefined,
  isPortRequired: boolean,
): Effect.Effect<OAuthCallbackServer, unknown> {
  const options = {
    host: settings.host,
    redirectHost: settings.redirectHost,
    path: settings.path,
    extraPaths,
    renderPage: (page: OAuthCallbackPage) =>
      page.ok
        ? oauthSuccessHtml("Signed in to the MCP server. You may now close this page.")
        : oauthErrorHtml(page.message, page.details),
  };
  return fromPromise(() => OAuthCallbackServer.listen({ ...options, port: port ?? 0 })).pipe(
    Effect.catch((error) =>
      isPortRequired || port === undefined
        ? Effect.fail(error)
        : fromPromise(() => OAuthCallbackServer.listen(options)),
    ),
  );
}

/**
 * Sign in to an MCP server. Uses the stored refresh token when possible; otherwise runs the browser
 * authorization code flow. Tokens are saved to `store`. Aborting `signal` stops the sign-in at any
 * step with `SignInCancelled`; requests to the authorization server are also time-limited.
 */
export function signInMcpServer(options: {
  serverUrl: string;
  store: McpOAuthStateStore;
  settings: McpOAuthSettings;
  challenge?: OAuthChallenge;
  prompt: McpSignInPrompt;
  signal?: AbortSignal;
}): Effect.Effect<void, unknown> {
  const { serverUrl, store, settings, signal } = options;
  return Effect.gen(function* () {
    if (signal?.aborted) return yield* new SignInCancelled();
    const stored = yield* fromPromise(async () => store.load());
    const isStepUp = options.challenge?.error === "insufficient_scope";
    const callbackOptions = callbackSettings(settings);
    // Reuse the port of the registered redirect URI so the registered client stays valid.
    const registered = registeredRedirectUrls(stored?.clientInformation)[0];
    const preferredPort =
      callbackOptions.port ?? (registered ? Number(new URL(registered).port) || undefined : undefined);
    const usesCimd = settings.clientRegistration === "cimd";
    yield* Effect.acquireUseRelease(
      listenForCallback(
        callbackOptions,
        // The redirect URI of a server-specific Client ID Metadata Document.
        usesCimd ? [`${CALLBACK_PATH}/${callbackId(serverUrl)}`] : [],
        preferredPort,
        callbackOptions.port !== undefined,
      ),
      (callback) =>
        Effect.gen(function* () {
          const redirectUrl = callbackOptions.fixedRedirectUrl ?? callback.redirectUrl;
          if (stored) {
            const next: McpOAuthState = { ...stored };
            // Every sign-in gets a fresh `state` parameter.
            delete next.oauthState;
            // A registered client cannot use another redirect URI, and its tokens belong to it. A Client ID
            // Metadata Document is not stored, so with one, a stored client was registered before and is replaced.
            const shouldKeepClient =
              settings.clientId ||
              (usesCimd
                ? !stored.clientInformation
                : registeredRedirectUrls(stored.clientInformation).includes(redirectUrl));
            if (!shouldKeepClient) {
              delete next.clientInformation;
              delete next.tokens;
              delete next.tokensExpireAt;
            }
            yield* fromPromise(async () => store.save(next));
          }

          let authorizationUrl: URL | undefined;
          const provider = createProvider(serverUrl, store, settings, redirectUrl, (url) => {
            authorizationUrl = url;
          });
          const flow = {
            serverUrl,
            fetch: timedFetch(),
            signal,
            resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
            authorizationServerMetadataUrl: settings.authServerMetadataUrl,
            // A server asking for more scope gets it on top of the configured scope and, since the challenge
            // may list only the missing scopes, on top of the scope granted so far.
            scope: mergeScopes(
              settings.scope,
              isStepUp ? stepUpScope(stored?.tokens?.scope, options.challenge?.scope) : options.challenge?.scope,
            ),
          };
          // A refresh keeps the granted scope; a server asking for more needs the browser flow.
          const outcome = yield* fromPromise(() => authorizeMcp(provider, { ...flow, skipRefresh: isStepUp }));
          if (outcome === "AUTHORIZED") return;
          if (!authorizationUrl)
            return yield* Effect.fail(new Error("OAuth flow did not produce an authorization URL"));

          const state = yield* fromPromise(() => provider.state());
          // The flow picks the redirect URI, which may be specific to the MCP server.
          const authorizationRedirectUrl = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl);
          options.prompt.showAuthorizationUrl(authorizationUrl);
          const { code, iss } = yield* waitForAuthorizationResponse(
            callback,
            state,
            authorizationRedirectUrl,
            options.prompt,
            signal,
          );
          yield* fromPromise(() => authorizeMcp(provider, { ...flow, authorizationCode: code, iss }));
        }).pipe(
          // Aborted requests fail with the signal's reason; report them as the cancellation they are.
          Effect.catch((error) => Effect.fail(signal?.aborted ? new SignInCancelled() : error)),
        ),
      (callback) => Effect.promise(() => callback.close()),
    );
  });
}
