import { randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHTTPTransport, type HTTPTransport, type HTTPTransportOptions } from "./http.ts";
import { CHAT_METHOD, chatRequestCodec, chatResponseCodec, unaryCodecs } from "./protobuf.ts";
import { object, type JsonObject } from "../types.ts";

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
// The CLI compresses frames only when they are at least 8192 bytes.
export const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 8 * 1024;
export const ASSIGN_MODEL_METHOD = "exa.api_server_pb.ApiServerService/AssignModel";
type Encoding = "proto" | "json" | "stream";

export function safeError(error: unknown, secrets: readonly string[] = []): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
  return text.replace(/devin-session-token\$[^\s"'<>]+/g, "[REDACTED]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 800);
}

export function requestSecrets(body: JsonObject, token?: string): string[] {
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata as JsonObject : {};
  // f is ciphertext that contains the API token. Treat it as sensitive as the token itself.
  const uppercaseFingerprint = typeof metadata.f === "string" ? metadata.f.toUpperCase() : undefined;
  return [token, metadata.apiKey, metadata.f, uppercaseFingerprint, body.apiKey, body.modelAssignmentJwt, body.code, body.authorizationCode, body.codeVerifier]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

export type RPCFailureKind = "authentication" | "permission" | "rate_limit" | "timeout" | "rpc";

export class RPCError extends Error {
  code: string;
  httpStatus?: number;
  retryAfterMs?: number;
  constructor(code: string, message: string, httpStatus?: number, retryAfterMs?: number) {
    super(`${code}: ${message}`);
    this.name = "RPCError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
    if (this.kind === "authentication") {
      this.message = this.message.slice(0, 600) + " The authentication credential is not valid. It may have expired or been revoked; sign in again with login.";
    }
  }
  get kind(): RPCFailureKind {
    // An error body that contradicts the HTTP status does not invalidate authentication.
    if (this.httpStatus !== undefined && this.httpStatus >= 400) {
      if (this.httpStatus === 401) return "authentication";
      if (this.httpStatus === 403) return "permission";
      if (this.httpStatus === 429) return "rate_limit";
      if (this.httpStatus === 408 || this.httpStatus === 504) return "timeout";
      return "rpc";
    }
    if (this.code === "unauthenticated") return "authentication";
    if (this.code === "permission_denied") return "permission";
    if (this.code === "resource_exhausted") return "rate_limit";
    if (this.code === "deadline_exceeded") return "timeout";
    return "rpc";
  }
}

export function isAuthenticationError(error: unknown): error is RPCError {
  return error instanceof RPCError && error.kind === "authentication";
}

export function failureDetails(error: unknown): JsonObject {
  if (error instanceof RPCError) return {
    category: error.kind, code: error.code,
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(isAuthenticationError(error) ? { requiresLogin: true } : {}),
  };
  if (error instanceof Error && error.name === "TimeoutError") return { category: "timeout", code: "deadline_exceeded" };
  if (error instanceof Error && error.name === "AbortError") return { category: "cancelled" };
  if (error instanceof Error && "code" in error && typeof error.code === "string" &&
      /^(ECONN|ENET|EHOST|EPIPE$|ENOTFOUND$|EAI_|ETIMEDOUT$|ERR_TLS_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_)/.test(error.code)) {
    return { category: "network", code: error.code };
  }
  return { category: "error" };
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000
    : /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /.test(value) ? Date.parse(value) - Date.now() : NaN;
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(milliseconds)) return undefined;
  return Math.max(0, milliseconds);
}

export function discardResponse(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/** Stops waiting even if an injected transport ignores the signal, and discards responses that arrive late. */
export function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal, onAbandoned?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let isSettled = false;
    const abort = () => {
      if (isSettled) return;
      isSettled = true;
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => {
      if (isSettled) { try { onAbandoned?.(value); } catch { /* cleanup of an already cancelled response */ } return; }
      isSettled = true;
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error) => {
      if (isSettled) return;
      isSettled = true;
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

export function endpoint(value: string): string {
  const url = new URL(value);
  const isLoopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("The endpoint must be HTTPS, or loopback HTTP for local verification.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("The endpoint must not contain credentials, a path, a query, or a fragment.");
  }
  return url.origin;
}

export function encodeFrame(bytes: Uint8Array, flags = 0): Buffer {
  const payload = Buffer.from(bytes);
  if (payload.length > MAX_FRAME_BYTES) throw new Error("The request frame exceeds 8 MiB.");
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export interface Frame {
  isEnd: boolean;
  data: JsonObject;
}

/** HTTP chunk boundaries and Connect frame boundaries are independent. */
export async function* decodeFrames(
  chunks: AsyncIterable<Uint8Array>,
  options: { compression?: "identity" | "gzip" } = {},
): AsyncGenerator<Frame> {
  let buffered: Buffer = Buffer.alloc(0);
  let hasEnded = false;
  let wireBytes = 0;
  let decodedBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of chunks) {
    wireBytes += chunk.byteLength;
    if (wireBytes > MAX_RESPONSE_BYTES) throw new Error("The response exceeds 64 MiB.");
    if (hasEnded && chunk.byteLength > 0) throw new Error("Data follows EndStream.");
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 5) {
      if (hasEnded) throw new Error("A frame follows EndStream.");
      const flags = buffered[0];
      if ((flags & ~3) !== 0) throw new Error(`Unknown Connect flags: ${flags}`);
      const payloadBytes = buffered.readUInt32BE(1);
      if (payloadBytes > MAX_FRAME_BYTES) throw new Error("The response frame exceeds 8 MiB.");
      if (buffered.length < 5 + payloadBytes) break;
      let payload: Buffer = buffered.subarray(5, 5 + payloadBytes);
      buffered = buffered.subarray(5 + payloadBytes);
      if (flags & 1) {
        if (options.compression !== "gzip") throw new Error("A compressed frame has no valid gzip encoding header.");
        try { payload = gunzipSync(payload, { maxOutputLength: MAX_FRAME_BYTES }); }
        catch { throw new Error("The gzip frame is corrupt or exceeds the decompression limit."); }
      }
      decodedBytes += payload.byteLength;
      if (decodedBytes > MAX_RESPONSE_BYTES) throw new Error("The decompressed response exceeds 64 MiB.");
      hasEnded = Boolean(flags & 2);
      let data: JsonObject;
      if (hasEnded) {
        try { data = object(JSON.parse(decoder.decode(payload)), "EndStream"); }
        catch { throw new Error("EndStream is not a valid UTF-8 JSON object."); }
      } else data = chatResponseCodec.decode(payload);
      yield { isEnd: hasEnded, data };
    }
  }
  if (buffered.length !== 0) throw new Error("The connection ended with an incomplete Connect frame.");
  if (!hasEnded) throw new Error("The connection ended without EndStream.");
}

async function* responseChunks(response: Response, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (!response.body) throw new Error("The response has no body.");
  const reader = response.body.getReader();
  let isComplete = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await awaitWithSignal(reader.read(), signal);
      if (item.done) { isComplete = true; return; }
      yield item.value;
    }
  } finally {
    try {
      if (!isComplete) {
        const cancelled = reader.cancel().catch(() => {});
        // Do not wait past the deadline even if the injected stream's cancel never settles.
        if (!signal.aborted) await awaitWithSignal(cancelled, signal);
      }
    } finally { reader.releaseLock(); }
  }
}

async function boundedBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of responseChunks(response, signal)) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error("The response size limit was exceeded.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function boundedJSON(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const bytes = await boundedBytes(response, maxBytes, signal);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("The server did not return valid JSON."); }
}

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
  onDispatched?: () => void;
  headers?: Record<string, string | null>;
  onPayload?: (payload: JsonObject, signal: AbortSignal) => JsonObject | undefined | Promise<JsonObject | undefined>;
  onResponse?: (response: { status: number; headers: Record<string, string> }, signal: AbortSignal) => void | Promise<void>;
  /** Observes each parsed frame before normalization and error classification. */
  onFrame?: (frame: Frame, signal: AbortSignal) => void | Promise<void>;
}

function requestHeaders(defaults: Record<string, string>, overrides: StreamRequestContext["headers"]): Record<string, string> {
  const headers = new Headers(defaults);
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (["host", "content-length"].includes(name.toLowerCase()) && value !== headers.get(name)) {
      throw new Error("Host and Content-Length are managed by the transport from the actual destination and body.");
    }
    if (value === null) headers.delete(name); else headers.set(name, value);
  }
  return Object.fromEntries(headers.entries());
}

export interface ConnectClientOptions {
  baseURL: string;
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  http?: HTTPTransportOptions;
  compressionThresholdBytes?: number;
  trace?: () => string;
  onRequest?: (attempt: RequestAttempt) => void;
}

interface RequestScope {
  signal: AbortSignal;
  abort(reason: unknown): void;
  dispose(): void;
}

export class ConnectClient {
  readonly baseURL: string;
  readonly token?: string;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
  readonly compressionThresholdBytes: number;
  readonly trace: () => string;
  readonly onRequest?: ConnectClientOptions["onRequest"];
  private readonly httpTransport?: HTTPTransport;
  private readonly lifetime = new AbortController();
  private authenticationError?: RPCError;
  private isClosed = false;

  constructor(options: ConnectClientOptions) {
    this.baseURL = endpoint(options.baseURL);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647) {
      throw new Error("The request timeout must be an integer from 1 to 2147483647ms.");
    }
    if (options.fetch && options.http) throw new Error("An injected fetch and the HTTP transport option cannot be used together.");
    this.httpTransport = options.fetch ? undefined : createHTTPTransport(options.http);
    this.fetchImpl = options.fetch ?? this.httpTransport!.fetch;
    this.compressionThresholdBytes = options.compressionThresholdBytes ?? DEFAULT_COMPRESSION_THRESHOLD_BYTES;
    if (!Number.isSafeInteger(this.compressionThresholdBytes) || this.compressionThresholdBytes < 1) {
      throw new Error("The compression threshold must be a positive integer number of bytes.");
    }
    this.trace = options.trace ?? (() => `${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-0`);
    this.onRequest = options.onRequest;
  }

  get isAuthenticationInvalid(): boolean { return this.authenticationError !== undefined; }

  /** Retry waits between requests are also tied to authentication invalidation and close(). */
  get abortSignal(): AbortSignal { return this.lifetime.signal; }

  assertAuthenticated(): void {
    if (this.authenticationError) throw this.authenticationError;
    if (this.isClosed) throw new Error("The client is closed.");
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.lifetime.abort(new DOMException("The client is closed.", "AbortError"));
    this.httpTransport?.close();
  }

  private requestScope(callerSignal?: AbortSignal): RequestScope {
    callerSignal?.throwIfAborted();
    this.assertAuthenticated();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException(`The request exceeded the ${this.timeoutMs}ms timeout.`, "TimeoutError")), this.timeoutMs);
    return {
      signal: AbortSignal.any([...(callerSignal ? [callerSignal] : []), this.lifetime.signal, deadline.signal]),
      abort: (reason) => deadline.abort(reason),
      dispose: () => clearTimeout(timer),
    };
  }

  private failure(error: unknown, scope: RequestScope, secrets: string[]): Error {
    const failure = scope.signal.aborted ? scope.signal.reason : error;
    if (isAuthenticationError(failure) && this.token && !this.authenticationError) {
      this.authenticationError = failure;
      // Other in-flight requests are aborted too. The stored token is not deleted and no automatic re-login happens.
      this.lifetime.abort(failure);
    }
    scope.abort(failure);
    if (failure instanceof RPCError) {
      failure.message = safeError(failure, secrets); failure.code = safeError(failure.code, secrets);
      return failure;
    }
    const result = new Error(safeError(failure, secrets)) as Error & { code?: string };
    if (failure instanceof Error) result.name = failure.name;
    const cause = failure instanceof Error ? failure.cause : undefined;
    const coded = failure && typeof failure === "object" && "code" in failure ? failure
      : cause && typeof cause === "object" && "code" in cause ? cause : undefined;
    if (coded && typeof coded.code === "string") result.code = safeError(coded.code, secrets);
    return result;
  }

  private async post(method: string, body: JsonObject, encoding: Encoding, signal: AbortSignal, context: StreamRequestContext = {}): Promise<Response> {
    signal.throwIfAborted();
    this.assertAuthenticated();
    const isStreaming = encoding === "stream";
    if (isStreaming && method !== CHAT_METHOD) throw new Error("Unsupported streaming RPC.");
    const bytes = isStreaming ? chatRequestCodec.encode(body)
      : encoding === "proto" ? unaryCodecs(method).request.encode(body) : Buffer.from(JSON.stringify(body));
    if (bytes.length > MAX_FRAME_BYTES) throw new Error("The request body exceeds 8 MiB.");
    const isMetered = method === CHAT_METHOD || method === ASSIGN_MODEL_METHOD;
    const trace = method === CHAT_METHOD ? this.trace() : undefined;
    const secrets = requestSecrets(body, this.token);
    let isCompressed = isStreaming && bytes.length >= this.compressionThresholdBytes;
    const contentType = isStreaming ? "application/connect+proto" : encoding === "proto" ? "application/proto" : "application/json";
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      this.assertAuthenticated();
      const payload = isStreaming ? encodeFrame(isCompressed ? gzipSync(bytes) : bytes, isCompressed ? 1 : 0) : Buffer.from(bytes);
      const headers = requestHeaders({
        ...(this.token ? { authorization: `Basic ${this.token}-${this.token}` } : {}),
        ...(trace ? { "sentry-trace": trace } : {}),
        ...(isCompressed ? { "connect-content-encoding": "gzip" } : {}),
        "content-type": contentType,
        "connect-protocol-version": "1",
        accept: "*/*",
        "accept-encoding": "gzip",
        "content-length": String(payload.byteLength),
      }, context.headers);
      this.onRequest?.({ method: "POST", path: method, attempt, isMetered, isCompressed, stage: context.stage,
        modelUid: typeof body.chatModelUid === "string" ? body.chatModelUid : typeof body.modelRouterUid === "string" ? body.modelRouterUid : undefined });
      const responsePromise = this.fetchImpl(`${this.baseURL}/${method}`, {
        method: "POST", redirect: "error", headers,
        body: encoding === "json" ? payload.toString("utf8") : new Uint8Array(payload), signal,
      });
      try { if (attempt === 1) context.onDispatched?.(); }
      catch (error) { void responsePromise.then(discardResponse, () => {}); throw error; }
      const response = await awaitWithSignal(responsePromise, signal, discardResponse);
      try {
        if (context.onResponse) await awaitWithSignal(Promise.resolve(context.onResponse({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, signal)), signal);
      } catch (error) { discardResponse(response); throw error; }
      // Compression fallback the CLI uses. Keeps the same deadline, body, fingerprint, trace and per-attempt budget.
      // 401/403/429 and one-time login exchanges are never resent through this path.
      if (attempt === 1 && isCompressed && [408, 415, 500, 502, 503, 504].includes(response.status)) {
        discardResponse(response);
        isCompressed = false;
        continue;
      }
      if (response.status === 401) {
        discardResponse(response);
        throw new RPCError("unauthenticated", "HTTP 401: the server rejected the authentication credential.", 401);
      }
      if (!response.ok) {
        let details: JsonObject = {};
        try { details = object(await boundedJSON(response, 64 * 1024, signal), "RPC error"); }
        catch { signal.throwIfAborted(); }
        throw new RPCError(typeof details.code === "string" ? safeError(details.code, secrets) : `http_${response.status}`,
          safeError(typeof details.message === "string" ? details.message : `HTTP ${response.status}`, secrets),
          response.status, response.status === 429 ? retryAfterMs(response.headers) : undefined);
      }
      if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== contentType) {
        discardResponse(response);
        throw new Error(`Unexpected Content-Type (expected: ${contentType})`);
      }
      return response;
    }
  }

  async unary(method: string, body: JsonObject, signal?: AbortSignal, options: { encoding?: "proto" | "json" } = {}): Promise<JsonObject> {
    const scope = this.requestScope(signal);
    try {
      const encoding = options.encoding ?? "proto";
      const response = await this.post(method, body, encoding, scope.signal);
      const result = encoding === "json" ? object(await boundedJSON(response, 4 * 1024 * 1024, scope.signal), "RPC response")
        : unaryCodecs(method).response.decode(await boundedBytes(response, 4 * 1024 * 1024, scope.signal));
      scope.signal.throwIfAborted();
      return result;
    } catch (error) { throw this.failure(error, scope, requestSecrets(body, this.token)); }
    finally { scope.dispose(); }
  }

  async *stream(method: string, body: JsonObject, signal?: AbortSignal, context: StreamRequestContext = {}): AsyncGenerator<Frame> {
    const scope = this.requestScope(signal);
    let payload = body;
    const secrets = requestSecrets(body, this.token);
    // A custom header name alone cannot tell whether its value is secret.
    for (const value of Object.values(context.headers ?? {})) if (value) secrets.push(value);
    let frames: AsyncGenerator<Frame> | undefined;
    try {
      if (context.onPayload) {
        const replacement = await awaitWithSignal(Promise.resolve(context.onPayload(body, scope.signal)), scope.signal);
        if (replacement !== undefined) payload = object(replacement, "request payload");
      }
      secrets.push(...requestSecrets(payload, this.token));
      const response = await this.post(method, payload, "stream", scope.signal, context);
      const compression = response.headers.get("connect-content-encoding") ?? "identity";
      if (compression !== "identity" && compression !== "gzip") {
        discardResponse(response);
        throw new Error("Unsupported Connect response compression.");
      }
      frames = decodeFrames(responseChunks(response, scope.signal), { compression });
      while (true) {
        const item = await frames.next();
        if (item.done) break;
        const frame = item.value;
        scope.signal.throwIfAborted();
        if (context.onFrame) await awaitWithSignal(Promise.resolve(context.onFrame(frame, scope.signal)), scope.signal);
        if (frame.isEnd && frame.data.error) {
          const error = object(frame.data.error, "EndStream error");
          throw new RPCError(typeof error.code === "string" ? safeError(error.code, secrets) : "unknown",
            safeError(typeof error.message === "string" ? error.message : "Connect stream failed", secrets));
        }
        yield frame;
      }
    } catch (error) { throw this.failure(error, scope, [...secrets, ...requestSecrets(payload, this.token)]); }
    finally {
      // An observer failure aborts first in the catch above. Cleanup after a voluntary return keeps the existing RPC deadline.
      try { await frames?.return(undefined); } finally { scope.dispose(); }
    }
  }

  async getJSON(origin: string, path: string, signal?: AbortSignal): Promise<JsonObject> {
    const base = endpoint(origin);
    if (!path.startsWith("/v3/") || path.includes("..") || path.includes("?") || path.includes("#")) {
      throw new Error("Unsupported Devin REST path.");
    }
    const scope = this.requestScope(signal);
    try {
      this.onRequest?.({ method: "GET", path, attempt: 1, isMetered: false, isCompressed: false });
      const response = await awaitWithSignal(this.fetchImpl(`${base}${path}`, {
        method: "GET", redirect: "error", signal: scope.signal,
        headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), accept: "*/*",
          ...(path === "/v3/self" ? {} : { "accept-encoding": "gzip" }) },
      }), scope.signal, discardResponse);
      if (!response.ok) {
        discardResponse(response);
        throw new RPCError(response.status === 401 ? "unauthenticated" : `http_${response.status}`,
          `Devin REST HTTP ${response.status}`, response.status, response.status === 429 ? retryAfterMs(response.headers) : undefined);
      }
      return object(await boundedJSON(response, 4 * 1024 * 1024, scope.signal), "Devin REST response");
    } catch (error) { throw this.failure(error, scope, this.token ? [this.token] : []); }
    finally { scope.dispose(); }
  }
}
