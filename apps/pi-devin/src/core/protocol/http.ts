import { Agent as HTTPAgent, request as httpRequest } from "node:http";
import { Agent as HTTPSAgent, request as httpsRequest } from "node:https";
import { Readable, pipeline } from "node:stream";
import type { ConnectionOptions } from "node:tls";
import { createGunzip } from "node:zlib";

export interface HTTPTransportOptions {
  /** Trusts a user-supplied CA without disabling certificate or host verification. */
  ca?: ConnectionOptions["ca"];
}

export interface HTTPTransport {
  fetch: typeof fetch;
  close(): void;
}

/**
 * HTTP/1.1-only transport. Owns a per-client pool and verifies TLS certificates and hosts.
 * The 5000ms socket timeout spells out the previous Node global agent setting as a PoC policy;
 * it is not the overall RPC deadline. It does not claim to match the CLI's TLS or pool policy.
 */
export function createHTTPTransport(options: HTTPTransportOptions = {}): HTTPTransport {
  const httpAgent = new HTTPAgent({ keepAlive: true, timeout: 5000 });
  const httpsAgent = new HTTPSAgent({
    keepAlive: true, timeout: 5000, rejectUnauthorized: true, minVersion: "TLSv1.2",
    ALPNProtocols: ["http/1.1"], ...(options.ca === undefined ? {} : { ca: options.ca }),
  });
  let isClosed = false;
  const fetchHTTP: typeof fetch = async (input, init) => {
    if (isClosed) throw new Error("The HTTP transport is closed.");
    if (!(typeof input === "string" || input instanceof URL) || !["POST", "GET"].includes(init?.method ?? "") || init?.redirect !== "error") {
      throw new Error("This transport supports only URL GET/POST without redirects.");
    }
    const url = new URL(input);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Unsupported HTTP protocol.");
    const body = typeof init.body === "string" ? Buffer.from(init.body)
      : init.body instanceof Uint8Array ? Buffer.from(init.body) : undefined;
    if (init.method === "POST" && !body) throw new Error("A POST body must be a string or a byte array.");
    if (init.method === "GET" && init.body != null) throw new Error("A GET body is not supported.");
    const validated = new Headers(init.headers);
    const entries = init.headers instanceof Headers ? [...init.headers.entries()]
      : Array.isArray(init.headers) ? init.headers : Object.entries(init.headers ?? {});
    const headers: Record<string, string> = {};
    for (const [name] of entries) {
      const key = name.toLowerCase();
      if (key !== "host" && key !== "content-length") headers[key] = validated.get(name)!;
    }
    headers.host = url.host;
    if (body) headers["content-length"] = String(body.byteLength);
    return new Promise<Response>((resolve, reject) => {
      const isHTTPS = url.protocol === "https:";
      const send = isHTTPS ? httpsRequest : httpRequest;
      const request = send(url, {
        method: init.method, headers, signal: init.signal ?? undefined,
        agent: isHTTPS ? httpsAgent : httpAgent,
      }, (incoming) => {
        try {
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
              if (status >= 200 && status < 300) throw new Error("Unsupported HTTP response compression.");
            } else {
              const decoded = createGunzip();
              // Propagates consumer cancellation and compression errors to the original socket and keeps backpressure.
              pipeline(incoming, decoded, () => {});
              stream = decoded;
              responseHeaders.delete("content-encoding");
              responseHeaders.delete("content-length");
            }
          }
          resolve(new Response(hasNoBody ? null : Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
            status, headers: responseHeaders,
          }));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      });
      request.once("error", reject);
      request.once("upgrade", (_response, socket) => {
        socket.destroy();
        reject(new Error("HTTP upgrade is not supported."));
      });
      request.removeHeader("connection");
      request.end(body);
    });
  };
  return {
    fetch: fetchHTTP,
    close() {
      if (isClosed) return;
      isClosed = true;
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}

/** Default transport for existing direct callers. ConnectClient owns its own pool. */
export const requestHTTP: typeof fetch = createHTTPTransport().fetch;
