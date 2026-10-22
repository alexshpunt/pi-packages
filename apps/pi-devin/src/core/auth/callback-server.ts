import { createServer } from "node:http";
import { Effect, type Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
// A subpath import: the package index also loads NodeRedis, whose `redis` peer Pi's installer does not install.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { toDevinError, type DevinError } from "../errors.ts";
import { failWith } from "../validation.ts";
import { matchesState } from "./pkce.ts";

export interface CallbackHandlers {
  state: string;
  /** A code was accepted or the login was denied, so every later callback is refused. */
  isSettled(): boolean;
  /** Accepts a valid code once and reports whether it was taken. */
  accept(code: string): boolean;
  deny(): void;
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
};

const respond = (status: number, body: string) => HttpServerResponse.text(body, { status, headers: SECURITY_HEADERS, contentType: "text/plain; charset=utf-8" });

function callback(handlers: CallbackHandlers): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    let url: URL;
    try { url = new URL(request.url, "http://127.0.0.1"); } catch { return respond(400, "Invalid callback URL"); }
    if (request.method !== "GET" || url.pathname !== "/callback") return respond(404, "Not found");
    if (handlers.isSettled() || !matchesState(url.searchParams.get("state"), handlers.state)) return respond(400, "Invalid OAuth state");
    if (url.searchParams.has("error")) {
      handlers.deny();
      return respond(400, "Login was denied.");
    }
    if (!handlers.accept(url.searchParams.get("code") ?? "")) return respond(400, "Missing authorization code");
    return respond(200, "Authorization code received. Check the token exchange result in your terminal.");
  });
}

/** Serves the OAuth callback on a loopback port for the scope's lifetime and returns its redirect URL. Closing drops open connections at once. */
export function startCallbackServer(handlers: CallbackHandlers): Effect.Effect<string, DevinError, Scope.Scope> {
  return Effect.gen(function* () {
    const server = createServer();
    const httpServer = yield* NodeHttpServer.make(() => server, { port: 0, host: "127.0.0.1", disablePreemptiveShutdown: true }).pipe(
      Effect.mapError((error) => toDevinError(error.cause ?? error)),
    );
    // Runs before the server's own shutdown, which would otherwise wait for idle keep-alive connections.
    yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()));
    yield* httpServer.serve(callback(handlers));
    const address = server.address();
    if (!address || typeof address === "string") return yield* failWith("Could not determine the callback port.");
    return `http://127.0.0.1:${address.port}/callback`;
  });
}
