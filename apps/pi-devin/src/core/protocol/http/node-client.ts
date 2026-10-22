import { Agent as HTTPAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HTTPSAgent, request as httpsRequest } from "node:https";
import { pipeline, Readable } from "node:stream";
import type { ConnectionOptions } from "node:tls";
import { createGunzip } from "node:zlib";
import { Effect, type Scope } from "effect";
import { HttpClient, HttpClientError, type HttpClientRequest, type HttpClientResponse } from "effect/http";
import { DevinHttpResponse } from "./response.ts";

export interface HTTPTransportOptions {
  /** Trusts a user-supplied CA without disabling certificate or host verification. */
  ca?: ConnectionOptions["ca"];
}

export function transportError(request: HttpClientRequest.HttpClientRequest, cause: unknown): HttpClientError.HttpClientError {
  return new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, cause }) });
}

/** The request body as the transports send it: bytes or text, never a stream. */
export function requestBody(request: HttpClientRequest.HttpClientRequest): Uint8Array | string | undefined {
  const body = request.body;
  if (body._tag === "Uint8Array") return body.body;
  if (body._tag === "Raw" && (typeof body.body === "string" || body.body instanceof Uint8Array)) return body.body;
  return undefined;
}

function nodeResponse(incoming: IncomingMessage): Response | Error {
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) responseHeaders.append(name, entry);
  }
  const status = incoming.statusCode ?? 502;
  const hasNoBody = [204, 205, 304].includes(status);
  const encoding = responseHeaders.get("content-encoding")?.trim().toLowerCase();
  let stream: Readable = incoming;
  if (hasNoBody) incoming.resume();
  else if (encoding && encoding !== "identity") {
    if (encoding !== "gzip") {
      // An encoding problem in an error body must not hide an already received 401/403/429 status.
      if (status >= 200 && status < 300) return new Error("Unsupported HTTP response compression.");
    } else {
      const decoded = createGunzip();
      // Propagates consumer cancellation and compression errors to the original socket and keeps backpressure.
      pipeline(incoming, decoded, () => {});
      stream = decoded;
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
    }
  }
  try {
    return new Response(hasNoBody ? null : Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers: responseHeaders });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * HTTP/1.1-only `HttpClient` over `node:http`. Owns a pool for the scope's lifetime and verifies TLS certificates and hosts.
 * The 5000ms socket timeout spells out the previous Node global agent setting as a PoC policy;
 * it is not the overall RPC deadline. It does not claim to match the CLI's TLS or pool policy.
 */
export function makeNodeHttpClient(options: HTTPTransportOptions = {}): Effect.Effect<HttpClient.HttpClient, never, Scope.Scope> {
  return Effect.gen(function* () {
    const pool = yield* Effect.acquireRelease(Effect.sync(() => ({
      isClosed: false,
      http: new HTTPAgent({ keepAlive: true, timeout: 5000 }),
      https: new HTTPSAgent({
        keepAlive: true, timeout: 5000, rejectUnauthorized: true, minVersion: "TLSv1.2",
        ALPNProtocols: ["http/1.1"], ...(options.ca === undefined ? {} : { ca: options.ca }),
      }),
    })), (pool) => Effect.sync(() => {
      pool.isClosed = true;
      pool.http.destroy();
      pool.https.destroy();
    }));

    const send = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> => Effect.suspend(() => {
      if (pool.isClosed) return Effect.fail(transportError(request, new Error("The HTTP transport is closed.")));
      if (request.method !== "POST" && request.method !== "GET") return Effect.fail(transportError(request, new Error("This transport supports only URL GET/POST without redirects.")));
      let url: URL;
      try { url = new URL(request.url); } catch (error) { return Effect.fail(transportError(request, error)); }
      if (!["https:", "http:"].includes(url.protocol)) return Effect.fail(transportError(request, new Error("Unsupported HTTP protocol.")));
      const raw = requestBody(request);
      const body = raw === undefined ? undefined : Buffer.from(raw);
      if (request.method === "POST" && !body) return Effect.fail(transportError(request, new Error("A POST body must be a string or a byte array.")));
      if (request.method === "GET" && body) return Effect.fail(transportError(request, new Error("A GET body is not supported.")));
      let headers: Record<string, string>;
      try {
        // Validates names and values the same way fetch does before anything is sent.
        const validated = new Headers(Object.entries(request.headers));
        headers = {};
        for (const [name, value] of validated) if (name !== "host" && name !== "content-length") headers[name] = value;
      } catch (error) { return Effect.fail(transportError(request, error)); }
      headers.host = url.host;
      if (body) headers["content-length"] = String(body.byteLength);
      const isHTTPS = url.protocol === "https:";
      return Effect.callback<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>((resume) => {
        let isSettled = false;
        const fail = (cause: unknown) => {
          if (isSettled) return;
          isSettled = true;
          resume(Effect.fail(transportError(request, cause)));
        };
        const outgoing = (isHTTPS ? httpsRequest : httpRequest)(url, {
          method: request.method, headers, agent: isHTTPS ? pool.https : pool.http,
        }, (incoming) => {
          if (isSettled) { incoming.destroy(); return; }
          const response = nodeResponse(incoming);
          if (response instanceof Error) { incoming.destroy(); fail(response); return; }
          isSettled = true;
          resume(Effect.succeed(new DevinHttpResponse(request, response, () => { incoming.destroy(); outgoing.destroy(); })));
        });
        outgoing.on("error", fail);
        outgoing.once("upgrade", (_response, socket) => {
          socket.destroy();
          fail(new Error("HTTP upgrade is not supported."));
        });
        outgoing.removeHeader("connection");
        outgoing.end(body);
        return Effect.sync(() => {
          if (isSettled) return;
          isSettled = true;
          outgoing.destroy();
        });
      });
    });

    return HttpClient.makeWith<HttpClientError.HttpClientError, never, HttpClientError.HttpClientError, never>((request) => Effect.flatMap(request, send), Effect.succeed);
  });
}
