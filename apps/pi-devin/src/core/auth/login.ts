import { randomUUID } from "node:crypto";
import { Deferred, Effect, Exit, Fiber, Predicate } from "effect";
import { startDeadline } from "../cancellation.ts";
import { DevinError, RequestTimeout, toDevinError, type DevinFailure } from "../errors.ts";
import { makeConnectClient } from "../protocol/connect-client.ts";
import { endpoint } from "../protocol/endpoint.ts";
import { redactFailure } from "../redaction.ts";
import type { HttpTransport } from "../services/http-transport.ts";
import type { Credential } from "../types.ts";
import { failWith, requiredString } from "../validation.ts";
import { startCallbackServer } from "./callback-server.ts";
import { codeForExchange, createPKCE, isAuthorizationCode, matchesState, PKCE_CODE_PREFIX } from "./pkce.ts";
import { exchangeBrowserCode } from "./rest-exchange.ts";

export const DEFAULT_API_SERVER_URL = "https://server.codeium.com";
export const DEFAULT_WEBAPP_URL = "https://app.devin.ai";
export const DEFAULT_DEVIN_API_URL = "https://api.devin.ai";
const EXCHANGE_METHOD = "exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode";
const PKCE_EXCHANGE_METHOD = "exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode";
const LOGIN_TIMEOUT_MS = 300_000;
const CONNECT_EXCHANGE_TIMEOUT_MS = 30_000;

export type LoginFlow = "browser" | "manual" | "legacy-connect";
export interface LoginOptions {
  apiServerURL?: string;
  webappURL?: string;
  devinAPIURL?: string;
  timeoutMs?: number;
  /** Shows or opens the authorization URL. */
  onURL: (url: string) => Effect.Effect<void, DevinFailure>;
  /** Reads a one-time authorization code, never an API key or session token. Interrupted as soon as the browser callback wins. */
  promptCode?: Effect.Effect<string, DevinFailure>;
  encoding?: "proto" | "json";
  flow?: LoginFlow;
}

/** The new account UI defaults to the REST browser flow. An explicit encoding keeps the legacy Connect path. Code exchanges go through `HttpTransport`. */
export function loginAccount(options: LoginOptions): Effect.Effect<Credential, DevinFailure, HttpTransport> {
  return login({ ...options, flow: options.flow ?? (options.encoding === undefined ? "browser" : "legacy-connect") });
}

function validate(options: LoginOptions, flow: LoginFlow): Effect.Effect<void, DevinError> {
  if (!["browser", "manual", "legacy-connect"].includes(flow)) return failWith("Unsupported login flow.");
  if (options.encoding !== undefined && options.encoding !== "proto" && options.encoding !== "json") return failWith("The login encoding must be proto or json.");
  if (flow === "browser" && options.encoding !== undefined) return failWith("A Connect encoding cannot be used with the REST browser login.");
  if (flow !== "browser" && options.devinAPIURL !== undefined) return failWith("The Devin REST login server can only be set for the REST browser flow.");
  if (flow === "manual" && !options.promptCode) return failWith("Manual login requires an authorization code prompt.");
  return Effect.void;
}

function connectExchange(apiServerURL: string, code: string, verifier: string, options: LoginOptions): Effect.Effect<string, DevinFailure, HttpTransport> {
  return Effect.scoped(Effect.gen(function* () {
    const client = yield* makeConnectClient({ baseURL: apiServerURL, timeoutMs: CONNECT_EXCHANGE_TIMEOUT_MS });
    const isWindsurfCode = code.startsWith(PKCE_CODE_PREFIX);
    const method = isWindsurfCode ? PKCE_EXCHANGE_METHOD : EXCHANGE_METHOD;
    const body = isWindsurfCode ? { authorizationCode: codeForExchange(code), codeVerifier: verifier } : { code, codeVerifier: verifier };
    const exchanged = yield* client.unary(method, body, { encoding: options.encoding ?? "proto" });
    if (isWindsurfCode && Predicate.isString(exchanged.apiServerUrl) && exchanged.apiServerUrl && (yield* endpoint(exchanged.apiServerUrl)) !== apiServerURL) {
      return yield* failWith("The login returned a different API server. Set the target with --api-server-url and sign in again.");
    }
    const tokenField = isWindsurfCode ? "apiKey" : "sessionToken";
    return yield* requiredString(exchanged[tokenField], `${method}.${tokenField}`);
  }));
}

/** Keeps the default Connect contract of the existing shared login(). Storage and opening the browser belong to the caller. */
export function login(options: LoginOptions): Effect.Effect<Credential, DevinFailure, HttpTransport> {
  return Effect.gen(function* () {
    const flow = options.flow ?? "legacy-connect";
    yield* validate(options, flow);
    const apiServerURL = yield* endpoint(options.apiServerURL ?? DEFAULT_API_SERVER_URL);
    const webappURL = yield* endpoint(options.webappURL ?? DEFAULT_WEBAPP_URL);
    const devinAPIURL = yield* endpoint(options.devinAPIURL ?? DEFAULT_DEVIN_API_URL);
    const pkce = createPKCE();
    if (flow !== "legacy-connect") pkce.state = randomUUID();
    let authorizationCode = "";
    const secrets = () => [authorizationCode, codeForExchange(authorizationCode), pkce.verifier];

    return yield* Effect.scoped(Effect.gen(function* () {
      const deadline = yield* startDeadline(options.timeoutMs ?? LOGIN_TIMEOUT_MS, () => new RequestTimeout({ message: "OAuth login timed out." }));
      return yield* deadline.guard(Effect.gen(function* () {
        const code = yield* Deferred.make<string, DevinFailure>();
        let hasAcceptedCode = false;
        const accept = (value: string) => {
          if (hasAcceptedCode || !isAuthorizationCode(value)) return false;
          hasAcceptedCode = true;
          authorizationCode = value;
          Deferred.doneUnsafe(code, Exit.succeed(value));
          return true;
        };
        const redirectURL = flow === "manual" ? undefined : yield* startCallbackServer({
          state: pkce.state, accept, isSettled: () => hasAcceptedCode,
          deny: () => {
            hasAcceptedCode = true;
            Deferred.doneUnsafe(code, Exit.fail(new DevinError({ message: "OAuth login was denied." })));
          },
        });
        const authorizationURL = new URL(flow === "manual" ? "/devin/account/login" : "/auth/cli/continue", webappURL);
        authorizationURL.search = new URLSearchParams({
          redirect_uri: flow === "manual" ? "chisel-show-auth-token" : redirectURL!,
          state: pkce.state,
          ...(flow === "manual" ? {} : { prompt: "select_account" }),
          code_challenge: pkce.challenge, code_challenge_method: "S256",
        }).toString();
        yield* options.onURL(authorizationURL.href);
        // Typed input races the browser callback; the first valid code wins and the other wait is stopped.
        const input = options.promptCode && !hasAcceptedCode ? yield* Effect.forkScoped(Effect.gen(function* () {
          const value = (yield* options.promptCode!).trim();
          if (hasAcceptedCode) return;
          authorizationCode = value; // Also keeps the raw code out of errors.
          let candidate = value;
          if (/^https?:\/\//.test(candidate)) {
            const pasted = yield* Effect.try({ try: () => new URL(candidate), catch: toDevinError });
            if (!redirectURL || pasted.origin + pasted.pathname !== redirectURL || !matchesState(pasted.searchParams.get("state"), pkce.state)) {
              return yield* failWith("The pasted callback URL or state does not match.");
            }
            candidate = pasted.searchParams.get("code") ?? "";
          }
          if (!accept(candidate)) return yield* failWith("Enter a valid authorization code. API keys and session tokens are not accepted.");
        }).pipe(Effect.catch((error) => hasAcceptedCode ? Effect.void : Deferred.fail(code, error)))) : undefined;
        const accepted = yield* Deferred.await(code);
        if (input) yield* Fiber.interrupt(input);
        const sessionToken = flow === "browser"
          ? yield* exchangeBrowserCode({ origin: devinAPIURL, code: accepted, verifier: pkce.verifier })
          : yield* connectExchange(apiServerURL, accepted, pkce.verifier, options);
        return { version: 1, sessionToken, apiServerURL, createdAt: new Date().toISOString() } satisfies Credential;
      }));
    })).pipe(Effect.catch((error) => Effect.fail(redactFailure(error, secrets()))));
  });
}
