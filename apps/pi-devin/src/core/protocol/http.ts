import { Effect, Stream } from "effect";
import type { HttpClientError, HttpClientResponse } from "effect/http";
import { DevinError, toDevinFailure, type DevinFailure } from "../errors.ts";
import { failWith } from "../validation.ts";

export { discardResponse } from "./http/response.ts";
export { makeFetchHttpClient } from "./http/fetch-client.ts";
export { makeNodeHttpClient, type HTTPTransportOptions } from "./http/node-client.ts";

/** Keeps the transport cause (message and Node error code) so callers can tell network failures apart. */
export function fromHttpClientError(error: HttpClientError.HttpClientError): DevinFailure {
  const reason = error.reason;
  switch (reason._tag) {
    case "TransportError":
    case "DecodeError":
    case "EncodeError":
    case "InvalidUrlError": return toDevinFailure(reason.cause ?? reason.description ?? error.message);
    case "EmptyBodyError": return new DevinError({ message: reason.description ?? "The response has no body." });
    case "StatusCodeError": return new DevinError({ message: reason.description ?? error.message });
  }
}

/** The response body as chunks, failing as Devin failures. */
export function responseChunks(response: HttpClientResponse.HttpClientResponse): Stream.Stream<Uint8Array, DevinFailure> {
  return Stream.mapError(response.stream, fromHttpClientError);
}

export function readBoundedBytes(response: HttpClientResponse.HttpClientResponse, maxBytes: number): Effect.Effect<Buffer, DevinFailure> {
  return Effect.suspend(() => {
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    return responseChunks(response).pipe(
      Stream.runForEach((chunk) => {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) return failWith("The response size limit was exceeded.");
        chunks.push(chunk);
        return Effect.void;
      }),
      Effect.map(() => Buffer.concat(chunks)),
    );
  });
}

export function readBoundedJSON(response: HttpClientResponse.HttpClientResponse, maxBytes: number): Effect.Effect<unknown, DevinFailure> {
  return Effect.flatMap(readBoundedBytes(response, maxBytes), (bytes) => Effect.try({
    try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    catch: () => new DevinError({ message: "The server did not return valid JSON." }),
  }));
}
