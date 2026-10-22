import { Effect, Inspectable, Option, Stream } from "effect";
import { pipeArguments } from "effect/Pipeable";
import { HttpClientError, HttpClientResponse, HttpIncomingMessage, type HttpClientRequest } from "effect/http";

const ignore = () => {};

/**
 * A web `Response` seen through Effect's `HttpClientResponse`. Unlike `HttpClientResponse.fromWeb`, ending its body early
 * never waits for an uncooperative `cancel()`, and the transport is stopped only while the body is still in flight,
 * so a fully read keep-alive connection stays reusable.
 */
export class DevinHttpResponse extends Inspectable.Class implements HttpClientResponse.HttpClientResponse {
  readonly [HttpClientResponse.TypeId] = HttpClientResponse.TypeId;
  readonly [HttpIncomingMessage.TypeId] = HttpIncomingMessage.TypeId;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly source: Response;
  private readonly web: HttpClientResponse.HttpClientResponse;
  private readonly abortTransport: () => void;
  private isBodySettled = false;

  constructor(request: HttpClientRequest.HttpClientRequest, source: Response, abortTransport: () => void) {
    super();
    this.request = request;
    this.source = source;
    this.abortTransport = abortTransport;
    this.web = HttpClientResponse.fromWeb(request, source);
  }

  get url() { return this.web.url; }
  get status() { return this.source.status; }
  get headers() { return this.web.headers; }
  get cookies() { return this.web.cookies; }
  get remoteAddress() { return Option.none<string>(); }
  get formData() { return this.web.formData; }
  get json() { return this.web.json; }
  get text() { return this.web.text; }
  get urlParamsBody() { return this.web.urlParamsBody; }
  get arrayBuffer() { return this.web.arrayBuffer; }

  /** Stops an unread or partly read body. Responses that arrive after their request ended are discarded the same way. */
  get discard(): Effect.Effect<void> {
    return Effect.sync(() => this.abandon(undefined));
  }

  private abandon(reader: ReadableStreamDefaultReader<Uint8Array> | undefined): void {
    if (this.isBodySettled) return;
    this.isBodySettled = true;
    try {
      if (reader) { void reader.cancel().catch(ignore); reader.releaseLock(); }
      else if (this.source.body && !this.source.body.locked) void this.source.body.cancel().catch(ignore);
    } finally { this.abortTransport(); }
  }

  get stream(): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> {
    return Stream.suspend(() => {
      const body = this.source.body;
      if (!body || this.isBodySettled) {
        return Stream.fail(new HttpClientError.HttpClientError({
          reason: new HttpClientError.EmptyBodyError({ request: this.request, response: this, description: "The response has no body." }),
        }));
      }
      const reader = body.getReader();
      const iterator: AsyncIterator<Uint8Array> = {
        next: async () => {
          try {
            const item = await reader.read();
            if (item.done && !this.isBodySettled) { this.isBodySettled = true; reader.releaseLock(); }
            return item.done ? { done: true, value: undefined } : item;
          } catch (error) {
            this.abandon(reader);
            throw error;
          }
        },
        // Called when the consumer stops early. Cancellation is started but never awaited.
        return: async () => {
          this.abandon(reader);
          return { done: true, value: undefined };
        },
      };
      return Stream.fromAsyncIterable({ [Symbol.asyncIterator]: () => iterator }, (cause) => new HttpClientError.HttpClientError({
        reason: new HttpClientError.DecodeError({ request: this.request, response: this, cause }),
      }));
    });
  }

  toJSON(): unknown {
    return HttpIncomingMessage.inspect(this, { _id: "HttpClientResponse", request: this.request.toJSON(), status: this.status });
  }

  pipe() {
    // biome-ignore lint/complexity/noArguments: Pipeable forwards the call's arguments.
    return pipeArguments(this, arguments);
  }
}

/** Discards the body of a response this package's transports produced. */
export function discardResponse(response: HttpClientResponse.HttpClientResponse): Effect.Effect<void> {
  return response instanceof DevinHttpResponse ? response.discard : Effect.void;
}
