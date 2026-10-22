import { Effect } from "effect";
import { HttpClient, type HttpClientError, type HttpClientRequest, type HttpClientResponse } from "effect/http";
import { requestBody, transportError } from "./node-client.ts";
import { DevinHttpResponse } from "./response.ts";

const ignore = () => {};

/**
 * `HttpClient` over an injected `fetch`, such as the one Pi passes in stream options. Sends the transport's exact headers
 * and body, never follows redirects, and discards a response that arrives after its request ended.
 */
export function makeFetchHttpClient(fetchImpl: typeof fetch): HttpClient.HttpClient {
  const send = (request: HttpClientRequest.HttpClientRequest) => Effect.callback<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>((resume) => {
    const controller = new AbortController();
    let isSettled = false;
    let pending: Promise<Response>;
    try {
      pending = Promise.resolve(fetchImpl(request.url, {
        method: request.method, redirect: "error", headers: Object.fromEntries(Object.entries(request.headers)),
        body: requestBody(request) as BodyInit | undefined, signal: controller.signal,
      }));
    } catch (error) {
      resume(Effect.fail(transportError(request, error)));
      return;
    }
    pending.then((response) => {
      if (isSettled) { void response.body?.cancel().catch(ignore); return; }
      isSettled = true;
      resume(Effect.succeed(new DevinHttpResponse(request, response, () => controller.abort())));
    }, (error: unknown) => {
      if (isSettled) return;
      isSettled = true;
      resume(Effect.fail(transportError(request, error)));
    });
    return Effect.sync(() => {
      if (isSettled) return;
      isSettled = true;
      controller.abort();
    });
  });
  return HttpClient.makeWith<HttpClientError.HttpClientError, never, HttpClientError.HttpClientError, never>((request) => Effect.flatMap(request, send), Effect.succeed);
}
