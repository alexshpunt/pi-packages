import { Predicate } from "effect";
import { Cancelled, DevinError, RequestTimeout, RPCError, type DevinFailure } from "./errors.ts";
import type { JsonObject } from "./types.ts";

export function safeError(error: unknown, secrets: readonly string[] = []): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
  return text.replace(/devin-session-token\$[^\s"'<>]+/g, "[REDACTED]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 800);
}

export function requestSecrets(body: JsonObject, token?: string): string[] {
  const metadata = Predicate.isObject(body.metadata) ? body.metadata as JsonObject : {};
  // f is ciphertext that contains the API token. Treat it as sensitive as the token itself.
  const uppercaseFingerprint = Predicate.isString(metadata.f) ? metadata.f.toUpperCase() : undefined;
  return [token, metadata.apiKey, metadata.f, uppercaseFingerprint, body.apiKey, body.modelAssignmentJwt, body.code, body.authorizationCode, body.codeVerifier]
    .filter((value): value is string => Predicate.isString(value) && value.length > 0);
}

/** The same failure with tokens, codes and other secrets removed from its message. */
export function redactFailure(failure: DevinFailure, secrets: readonly string[]): DevinFailure {
  switch (failure._tag) {
    case "RPCError": return new RPCError({
      code: safeError(failure.code, secrets), message: safeError(failure, secrets),
      httpStatus: failure.httpStatus, retryAfterMs: failure.retryAfterMs,
    });
    case "DevinError": return new DevinError({
      message: safeError(failure, secrets), code: failure.code === undefined ? undefined : safeError(failure.code, secrets),
    });
    case "Cancelled": return new Cancelled({ message: safeError(failure, secrets) });
    case "RequestTimeout": return new RequestTimeout({ message: safeError(failure, secrets) });
    case "ModelBudgetError": return failure;
  }
}
