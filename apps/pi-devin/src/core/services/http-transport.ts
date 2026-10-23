import { Context, Effect, Layer, type Scope } from "effect";
import type { HttpClient } from "effect/http";
import { makeFetchHttpClient } from "../protocol/http/fetch-client.ts";
import { makeNodeHttpClient, type HTTPTransportOptions } from "../protocol/http/node-client.ts";

export interface HttpTransportShape {
  /**
   * An `HttpClient` for the calling scope. The built-in transport opens its own keep-alive pool and destroys it with the scope,
   * so clients never share connections and closing one never drops another's.
   */
  readonly open: Effect.Effect<HttpClient.HttpClient, never, Scope.Scope>;
}

/** How Devin clients and logins reach the network. */
export class HttpTransport extends Context.Service<HttpTransport, HttpTransportShape>()("pi-devin/HttpTransport") {}

/** Node's `http`/`https`: TLS 1.2 or later with certificate and host checks, HTTP/1.1 only, and a pool per opening scope. */
export function nodeTransport(options: HTTPTransportOptions = {}): HttpTransportShape {
  return { open: makeNodeHttpClient(options) };
}

/** An injected `fetch`, such as the one Pi passes in stream options. */
export function fetchTransport(fetchImpl: typeof fetch): HttpTransportShape {
  return { open: Effect.sync(() => makeFetchHttpClient(fetchImpl)) };
}

export const NodeHttpTransport = (options?: HTTPTransportOptions): Layer.Layer<HttpTransport> => Layer.succeed(HttpTransport, nodeTransport(options));
export const FetchHttpTransport = (fetchImpl: typeof fetch): Layer.Layer<HttpTransport> => Layer.succeed(HttpTransport, fetchTransport(fetchImpl));
