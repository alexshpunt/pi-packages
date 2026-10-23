import { Data, Predicate } from "effect";

/** A failure whose message is safe to show. `code` keeps a Node or library error code, such as `ECONNRESET`, for classification. */
export class DevinError extends Data.TaggedError("DevinError")<{
  readonly message: string;
  readonly code?: string | undefined;
}> {}

/** Cancellation by the caller, the lifecycle or a closed client. Keeps the `AbortError` name hosts recognize. */
export class Cancelled extends Data.TaggedError("Cancelled")<{ readonly message: string }> {
  override get name(): string { return "AbortError"; }
}

/** A local deadline or a host timeout. Keeps the `TimeoutError` name hosts recognize. */
export class RequestTimeout extends Data.TaggedError("RequestTimeout")<{ readonly message: string }> {
  override get name(): string { return "TimeoutError"; }
}

export class ModelBudgetError extends Data.TaggedError("ModelBudgetError")<{ readonly limit: number }> {
  override get message(): string { return `Used all ${this.limit} Devin model HTTP requests in the budget.`; }
  override get name(): string { return "ModelBudgetError"; }
}

export type RPCFailureKind = "authentication" | "permission" | "rate_limit" | "timeout" | "rpc";

function rpcFailureKind(code: string, httpStatus: number | undefined): RPCFailureKind {
  // An error body that contradicts the HTTP status does not invalidate authentication.
  if (httpStatus !== undefined && httpStatus >= 400) {
    if (httpStatus === 401) return "authentication";
    if (httpStatus === 403) return "permission";
    if (httpStatus === 429) return "rate_limit";
    if (httpStatus === 408 || httpStatus === 504) return "timeout";
    return "rpc";
  }
  if (code === "unauthenticated") return "authentication";
  if (code === "permission_denied") return "permission";
  if (code === "resource_exhausted") return "rate_limit";
  if (code === "deadline_exceeded") return "timeout";
  return "rpc";
}

const AUTHENTICATION_NOTICE = " The authentication credential is not valid. It may have expired or been revoked; sign in again with login.";

/** An error the server reported over HTTP or Connect. `message` is already `code: detail`. */
export class RPCError extends Data.TaggedError("RPCError")<{
  readonly code: string;
  readonly message: string;
  readonly httpStatus?: number | undefined;
  readonly retryAfterMs?: number | undefined;
}> {
  static make(code: string, detail: string, httpStatus?: number, retryAfterMs?: number): RPCError {
    const message = `${code}: ${detail}`;
    return new RPCError({
      code, httpStatus, retryAfterMs,
      message: rpcFailureKind(code, httpStatus) === "authentication" ? message.slice(0, 600) + AUTHENTICATION_NOTICE : message,
    });
  }

  get kind(): RPCFailureKind { return rpcFailureKind(this.code, this.httpStatus); }
}

export type DevinFailure = DevinError | Cancelled | RequestTimeout | ModelBudgetError | RPCError;

const FAILURE_TAGS = new Set(["DevinError", "Cancelled", "RequestTimeout", "ModelBudgetError", "RPCError"]);

export function isDevinFailure(value: unknown): value is DevinFailure {
  return value instanceof Error && Predicate.hasProperty(value, "_tag") && FAILURE_TAGS.has(value._tag as string);
}

/** The Node error code of a failure or of its cause, used to tell network failures apart. */
function errorCode(value: unknown): string | undefined {
  if (Predicate.hasProperty(value, "code") && Predicate.isString(value.code)) return value.code;
  const cause = value instanceof Error ? value.cause : undefined;
  return Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) ? cause.code : undefined;
}

/** Turns anything thrown or rejected by foreign code, including abort reasons, into a typed failure. */
export function toDevinFailure(cause: unknown): DevinFailure {
  if (isDevinFailure(cause)) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const name = cause instanceof Error ? cause.name : undefined;
  if (name === "AbortError") return new Cancelled({ message });
  if (name === "TimeoutError") return new RequestTimeout({ message });
  return new DevinError({ message, code: errorCode(cause) });
}

/** Like `toDevinFailure` for synchronous library calls that cannot be cancelled: always a `DevinError`. */
export function toDevinError(cause: unknown): DevinError {
  return cause instanceof DevinError ? cause : new DevinError({ message: cause instanceof Error ? cause.message : String(cause), code: errorCode(cause) });
}

export function isAuthenticationError(error: unknown): error is RPCError {
  return error instanceof RPCError && error.kind === "authentication";
}

const NETWORK_CODES = /^(ECONN|ENET|EHOST|EPIPE$|ENOTFOUND$|EAI_|ETIMEDOUT$|ERR_TLS_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_)/;
const TRANSIENT_CONNECTION_CODES = /^(ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN|ERR_STREAM_PREMATURE_CLOSE)$/;

/** Failure classification for reports. Never includes a message, token or identifier. */
export function failureDetails(error: unknown): Record<string, unknown> {
  const failure = toDevinFailure(error);
  switch (failure._tag) {
    case "RPCError": return {
      category: failure.kind, code: failure.code,
      ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
      ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      ...(failure.kind === "authentication" ? { requiresLogin: true } : {}),
    };
    case "RequestTimeout": return { category: "timeout", code: "deadline_exceeded" };
    case "Cancelled": return { category: "cancelled" };
    case "DevinError": return failure.code !== undefined && NETWORK_CODES.test(failure.code) ? { category: "network", code: failure.code } : { category: "error" };
    case "ModelBudgetError": return { category: "error" };
  }
}

/** The request got no usable answer from a working server, so sending it again may succeed. TLS and certificate failures are not included. */
export function isTransientConnectionFailure(error: unknown): boolean {
  const failure = toDevinFailure(error);
  if (failure instanceof RPCError) return failure.code === "unavailable" || [502, 503, 504].includes(failure.httpStatus ?? 0);
  return failure instanceof DevinError && failure.code !== undefined && TRANSIENT_CONNECTION_CODES.test(failure.code);
}
