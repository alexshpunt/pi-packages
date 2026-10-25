import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Effect, Exit, Fiber, Predicate, Scope, Stream } from "effect";
import { HttpBody, HttpClientRequest, type HttpClient, type HttpClientResponse } from "effect/http";
import { guardAll, makeCancellation, startDeadline, startIdleDeadline, type Cancellation } from "../cancellation.ts";
import { Cancelled, isAuthenticationError, RPCError, toDevinError, type DevinError, type DevinFailure } from "../errors.ts";
import { redactFailure, requestSecrets, safeError } from "../redaction.ts";
import type { JsonObject } from "../types.ts";
import { failWith, object } from "../validation.ts";
import { endpoint } from "./endpoint.ts";
import { decodeFrames, encodeFrame, MAX_FRAME_BYTES, type Frame } from "./frames.ts";
import { HttpTransport } from "../services/http-transport.ts";
import { discardResponse, fromHttpClientError, readBoundedBytes, readBoundedJSON, responseChunks } from "./http.ts";
import { CHAT_METHOD, chatRequestCodec, unaryCodecs } from "./protobuf.ts";

// The CLI compresses frames only when they are at least 8192 bytes.
export const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 8 * 1024;
export const ASSIGN_MODEL_METHOD = "exa.api_server_pb.ApiServerService/AssignModel";
const DEFAULT_TIMEOUT_MS = 90_000;
const UNARY_RESPONSE_BYTES = 4 * 1024 * 1024;
const ERROR_BODY_BYTES = 64 * 1024;
/** Only an initial compressed request rejected with these statuses is resent once uncompressed. */
const COMPRESSION_FALLBACK_STATUSES = new Set([408, 415, 500, 502, 503, 504]);
type Encoding = "proto" | "json" | "stream";

export interface RequestAttempt {
  method: "POST" | "GET";
  path: string;
  attempt: number;
  isMetered: boolean;
  isCompressed: boolean;
  stage?: string;
  modelUid?: string;
}

export interface StreamRequestContext {
  stage?: string;
  /** Runs once, right after the first attempt was handed to the transport. */
  onDispatched?: Effect.Effect<void, DevinFailure>;
  headers?: Record<string, string | null>;
  onPayload?: (payload: JsonObject) => Effect.Effect<JsonObject | undefined, DevinFailure>;
  onResponse?: (response: { status: number; headers: Record<string, string> }) => Effect.Effect<void, DevinFailure>;
  /** Observes each parsed frame before normalization and error classification. */
  onFrame?: (frame: Frame) => Effect.Effect<void, DevinFailure>;
}

export interface ConnectClientOptions {
  baseURL: string;
  token?: string;
  /** A unary call must finish within it; a stream fails after this long without data. Defaults to 90000ms. */
  timeoutMs?: number;
  compressionThresholdBytes?: number;
  trace?: () => string;
  /** Sees every attempt before it is sent and can refuse it, for example when a request budget is used up. */
  onRequest?: (attempt: RequestAttempt) => Effect.Effect<void, DevinFailure>;
}

export interface ConnectClient {
  readonly baseURL: string;
  readonly token: string | undefined;
  readonly timeoutMs: number;
  readonly compressionThresholdBytes: number;
  readonly isAuthenticationInvalid: Effect.Effect<boolean>;
  readonly assertAuthenticated: Effect.Effect<void, DevinFailure>;
  /** Ends with the client: closing it or a confirmed 401 also stops waits between requests. */
  readonly lifetime: Cancellation;
  readonly close: Effect.Effect<void>;
  unary(method: string, body: JsonObject, options?: { encoding?: "proto" | "json" }): Effect.Effect<JsonObject, DevinFailure>;
  stream(method: string, body: JsonObject, context?: StreamRequestContext): Stream.Stream<Frame, DevinFailure>;
  getJSON(origin: string, path: string): Effect.Effect<JsonObject, DevinFailure>;
}

function retryAfterMs(headers: Headers | Record<string, string | undefined>): number | undefined {
  const value = (headers instanceof Headers ? headers.get("retry-after") : headers["retry-after"])?.trim();
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000
    : /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /.test(value) ? Date.parse(value) - Date.now() : NaN;
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(milliseconds)) return undefined;
  return Math.max(0, milliseconds);
}

function requestHeaders(defaults: Record<string, string>, overrides: StreamRequestContext["headers"]): Effect.Effect<Record<string, string>, DevinError> {
  return Effect.gen(function* () {
    const headers = yield* Effect.try({ try: () => new Headers(defaults), catch: toDevinError });
    for (const [name, value] of Object.entries(overrides ?? {})) {
      if (["host", "content-length"].includes(name.toLowerCase()) && value !== headers.get(name)) {
        return yield* failWith("Host and Content-Length are managed by the transport from the actual destination and body.");
      }
      yield* Effect.try({ try: () => { if (value === null) headers.delete(name); else headers.set(name, value); }, catch: toDevinError });
    }
    return Object.fromEntries(headers.entries());
  });
}

const defaultTrace = () => `${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-0`;

/**
 * A Connect client bound to one endpoint and token, sending through its own connection from `HttpTransport`.
 * It closes with the scope, or earlier through `close`.
 */
export function makeConnectClient(options: ConnectClientOptions): Effect.Effect<ConnectClient, DevinError, HttpTransport | Scope.Scope> {
  return Effect.gen(function* () {
    const baseURL = yield* endpoint(options.baseURL);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      return yield* failWith("The request timeout must be an integer from 1 to 2147483647ms.");
    }
    const compressionThresholdBytes = options.compressionThresholdBytes ?? DEFAULT_COMPRESSION_THRESHOLD_BYTES;
    if (!Number.isSafeInteger(compressionThresholdBytes) || compressionThresholdBytes < 1) {
      return yield* failWith("The compression threshold must be a positive integer number of bytes.");
    }
    const token = options.token;
    const trace = options.trace ?? defaultTrace;
    const transport = yield* HttpTransport;
    const poolScope = yield* Scope.make();
    const http: HttpClient.HttpClient = yield* transport.open.pipe(Scope.provide(poolScope));
    const lifetime = makeCancellation();
    let authenticationError: RPCError | undefined;
    let isClosed = false;

    const close = Effect.suspend(() => {
      if (isClosed) return Effect.void;
      isClosed = true;
      lifetime.cancelUnsafe(new Cancelled({ message: "The client is closed." }));
      return Scope.close(poolScope, Exit.void);
    });
    yield* Effect.addFinalizer(() => close);

    const assertAuthenticated: Effect.Effect<void, DevinFailure> = Effect.suspend((): Effect.Effect<void, DevinFailure> => authenticationError ? Effect.fail(authenticationError)
      : isClosed ? failWith("The client is closed.") : Effect.void);

    /** Only a confirmed 401 of this client invalidates it. Other in-flight requests stop too; the stored token is kept and nothing logs in again. */
    const failure = (secrets: () => readonly string[]) => (error: DevinFailure): Effect.Effect<never, DevinFailure> => Effect.suspend(() => {
      if (isAuthenticationError(error) && token && !authenticationError) {
        authenticationError = error;
        lifetime.cancelUnsafe(error);
      }
      return Effect.fail(redactFailure(error, secrets()));
    });

    /** Runs one RPC under its deadline and the client's lifetime. The deadline starts before any hook or byte is sent. */
    const withRequestScope = <A>(secrets: () => readonly string[], effect: Effect.Effect<A, DevinFailure, Scope.Scope>) => Effect.scoped(Effect.gen(function* () {
      yield* assertAuthenticated;
      const deadline = yield* startDeadline(timeoutMs);
      return yield* guardAll([deadline, lifetime])(effect);
    })).pipe(Effect.catch(failure(secrets)));

    const post = (method: string, body: JsonObject, encoding: Encoding, context: StreamRequestContext = {}): Effect.Effect<HttpClientResponse.HttpClientResponse, DevinFailure, Scope.Scope> => Effect.gen(function* () {
      yield* assertAuthenticated;
      const isStreaming = encoding === "stream";
      if (isStreaming && method !== CHAT_METHOD) return yield* failWith("Unsupported streaming RPC.");
      const bytes = isStreaming ? yield* chatRequestCodec.encode(body)
        : encoding === "proto" ? yield* Effect.flatMap(unaryCodecs(method), (codecs) => codecs.request.encode(body)) : Buffer.from(JSON.stringify(body));
      if (bytes.length > MAX_FRAME_BYTES) return yield* failWith("The request body exceeds 8 MiB.");
      const isMetered = method === CHAT_METHOD || method === ASSIGN_MODEL_METHOD;
      const sentryTrace = method === CHAT_METHOD ? trace() : undefined;
      let isCompressed = isStreaming && bytes.length >= compressionThresholdBytes;
      const contentType = isStreaming ? "application/connect+proto" : encoding === "proto" ? "application/proto" : "application/json";
      const modelUid = Predicate.isString(body.chatModelUid) ? body.chatModelUid : Predicate.isString(body.modelRouterUid) ? body.modelRouterUid : undefined;
      for (let attempt = 1; ; attempt++) {
        yield* assertAuthenticated;
        const compressed = isCompressed;
        const payload = isStreaming
          ? yield* encodeFrame(compressed ? yield* Effect.try({ try: () => gzipSync(bytes), catch: toDevinError }) : bytes, compressed ? 1 : 0)
          : Buffer.from(bytes);
        const headers = yield* requestHeaders({
          ...(token ? { authorization: `Basic ${token}-${token}` } : {}),
          ...(sentryTrace ? { "sentry-trace": sentryTrace } : {}),
          ...(compressed ? { "connect-content-encoding": "gzip" } : {}),
          "content-type": contentType,
          "connect-protocol-version": "1",
          accept: "*/*",
          "accept-encoding": "gzip",
          "content-length": String(payload.byteLength),
        }, context.headers);
        if (options.onRequest) yield* options.onRequest({ method: "POST", path: method, attempt, isMetered, isCompressed: compressed, stage: context.stage, modelUid });
        const request = HttpClientRequest.post(`${baseURL}/${method}`).pipe(
          HttpClientRequest.setBody(HttpBody.raw(encoding === "json" ? payload.toString("utf8") : new Uint8Array(payload))),
          HttpClientRequest.setHeaders(headers),
        );
        // The request leaves before onDispatched runs. If it is never joined, closing the scope stops it and discards a late response.
        const dispatched = yield* Effect.forkScoped(http.execute(request), { startImmediately: true });
        if (attempt === 1 && context.onDispatched) yield* context.onDispatched;
        const response = yield* Fiber.join(dispatched).pipe(Effect.mapError(fromHttpClientError));
        // An unread body is released on every path except a successful hand-off to the caller.
        yield* Effect.addFinalizer((exit) => Exit.isSuccess(exit) ? Effect.void : discardResponse(response));
        if (context.onResponse) yield* context.onResponse({ status: response.status, headers: { ...response.headers } });
        // Compression fallback the CLI uses. Keeps the same deadline, body, fingerprint, trace and per-attempt budget.
        // 401/403/429 and one-time login exchanges are never resent through this path.
        if (attempt === 1 && compressed && COMPRESSION_FALLBACK_STATUSES.has(response.status)) {
          yield* discardResponse(response);
          isCompressed = false;
          continue;
        }
        if (response.status === 401) {
          yield* discardResponse(response);
          return yield* Effect.fail(RPCError.make("unauthenticated", "HTTP 401: the server rejected the authentication credential.", 401));
        }
        if (response.status < 200 || response.status >= 300) {
          const secrets = requestSecrets(body, token);
          const details = yield* readBoundedJSON(response, ERROR_BODY_BYTES).pipe(Effect.flatMap((value) => object(value, "RPC error")), Effect.orElseSucceed((): JsonObject => ({})));
          return yield* Effect.fail(RPCError.make(Predicate.isString(details.code) ? safeError(details.code, secrets) : `http_${response.status}`,
            safeError(Predicate.isString(details.message) ? details.message : `HTTP ${response.status}`, secrets),
            response.status, response.status === 429 ? retryAfterMs(response.headers) : undefined));
        }
        if (response.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== contentType) {
          yield* discardResponse(response);
          return yield* failWith(`Unexpected Content-Type (expected: ${contentType})`);
        }
        return response;
      }
    });

    const unary: ConnectClient["unary"] = (method, body, unaryOptions = {}) => {
      const encoding = unaryOptions.encoding ?? "proto";
      return withRequestScope(() => requestSecrets(body, token), Effect.gen(function* () {
        const response = yield* post(method, body, encoding);
        return encoding === "json" ? yield* object(yield* readBoundedJSON(response, UNARY_RESPONSE_BYTES), "RPC response")
          : yield* Effect.flatMap(unaryCodecs(method), (codecs) => Effect.flatMap(readBoundedBytes(response, UNARY_RESPONSE_BYTES), codecs.response.decode));
      }));
    };

    const stream: ConnectClient["stream"] = (method, body, context = {}) => {
      const secrets = requestSecrets(body, token);
      // A custom header name alone cannot tell whether its value is secret.
      for (const value of Object.values(context.headers ?? {})) if (value) secrets.push(value);
      const frames = Stream.unwrap(Effect.gen(function* () {
        yield* assertAuthenticated;
        // A stream may answer for a long time; it ends only after `timeoutMs` without data, like Pi's idle HTTP timeout.
        const deadline = yield* startIdleDeadline(timeoutMs);
        const guard = guardAll([deadline, lifetime]);
        const opened = guard(Effect.gen(function* () {
          let payload = body;
          if (context.onPayload) {
            const replacement = yield* context.onPayload(body);
            if (replacement !== undefined) payload = yield* object(replacement, "request payload");
          }
          secrets.push(...requestSecrets(payload, token));
          const response = yield* post(method, payload, "stream", context);
          const compression = response.headers["connect-content-encoding"] ?? "identity";
          if (compression !== "identity" && compression !== "gzip") {
            yield* discardResponse(response);
            return yield* failWith("Unsupported Connect response compression.");
          }
          return decodeFrames(responseChunks(response).pipe(Stream.tap(() => deadline.touch)), { compression }).pipe(Stream.mapEffect((frame) => Effect.gen(function* () {
            if (context.onFrame) yield* context.onFrame(frame);
            if (frame.isEnd && frame.data.error) {
              const error = yield* object(frame.data.error, "EndStream error");
              return yield* Effect.fail(RPCError.make(Predicate.isString(error.code) ? safeError(error.code, secrets) : "unknown",
                safeError(Predicate.isString(error.message) ? error.message : "Connect stream failed", secrets)));
            }
            return frame;
          })));
        }));
        return Stream.unwrap(opened).pipe(Stream.interruptWhen(deadline.await), Stream.interruptWhen(lifetime.await));
      }));
      return frames.pipe(Stream.catch((error) => Stream.fromEffect(failure(() => secrets)(error))));
    };

    const getJSON: ConnectClient["getJSON"] = (origin, path) => Effect.gen(function* () {
      const base = yield* endpoint(origin);
      if (!path.startsWith("/v3/") || path.includes("..") || path.includes("?") || path.includes("#")) {
        return yield* failWith("Unsupported Devin REST path.");
      }
      return yield* withRequestScope(() => token ? [token] : [], Effect.gen(function* () {
        if (options.onRequest) yield* options.onRequest({ method: "GET", path, attempt: 1, isMetered: false, isCompressed: false });
        const request = HttpClientRequest.get(`${base}${path}`).pipe(HttpClientRequest.setHeaders({
          ...(token ? { authorization: `Bearer ${token}` } : {}), accept: "*/*",
          ...(path === "/v3/self" ? {} : { "accept-encoding": "gzip" }),
        }));
        const response = yield* http.execute(request).pipe(Effect.mapError(fromHttpClientError));
        yield* Effect.addFinalizer((exit) => Exit.isSuccess(exit) ? Effect.void : discardResponse(response));
        if (response.status < 200 || response.status >= 300) {
          yield* discardResponse(response);
          return yield* Effect.fail(RPCError.make(response.status === 401 ? "unauthenticated" : `http_${response.status}`,
            `Devin REST HTTP ${response.status}`, response.status, response.status === 429 ? retryAfterMs(response.headers) : undefined));
        }
        return yield* object(yield* readBoundedJSON(response, UNARY_RESPONSE_BYTES), "Devin REST response");
      }));
    });

    return {
      baseURL, token, timeoutMs, compressionThresholdBytes, lifetime, close, assertAuthenticated,
      isAuthenticationInvalid: Effect.sync(() => authenticationError !== undefined),
      unary, stream, getJSON,
    };
  });
}
