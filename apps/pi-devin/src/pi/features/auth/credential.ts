import { createHash } from "node:crypto";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import type { DevinError } from "../../../core/errors.ts";
import { endpoint } from "../../../core/protocol/endpoint.ts";
import type { Credential } from "../../../core/types.ts";
import { failWith, object, requiredString } from "../../../core/validation.ts";

export const OAUTH_ONLY_MESSAGE = "Devin uses only the OAuth account session from /login. API key authentication is not supported.";
/**
 * Pi checks the stored session again after this interval. It is not a server TTL: the server expiry is unknown, no new token
 * is issued, and each model request still checks the account outside Pi's credential lock.
 */
export const SESSION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function credentialFromOAuth(credential: OAuthCredential): Effect.Effect<Credential, DevinError> {
  return Effect.gen(function* () {
    // 0.1.4 and earlier stored `expires: 0`; Pi checks such a session again on its next use.
    if (credential.type !== "oauth" || credential.refresh !== "" || !Number.isSafeInteger(credential.expires) || credential.expires < 0) {
      return yield* failWith("Unsupported Devin account credential. Sign in again with /login.");
    }
    const metadata = yield* object(credential.devin, "Devin credential metadata");
    if (metadata.version !== 1) return yield* failWith("The Devin account credential version differs. Sign in again with /login.");
    return {
      version: 1,
      sessionToken: yield* requiredString(credential.access, "Devin credential access"),
      apiServerURL: yield* endpoint(yield* requiredString(metadata.apiServerURL, "Devin credential API server")),
      createdAt: yield* requiredString(metadata.createdAt, "Devin credential creation time"),
    } satisfies Credential;
  });
}

export function credentialKey(credential: Credential): string {
  return createHash("sha256").update(credential.apiServerURL + "\0" + credential.sessionToken).digest("hex");
}

/** Endpoint mismatches are rejected separately by the model list scope. This only checks that the session came from OAuth. */
export function sessionKey(credential: Credential): string {
  return createHash("sha256").update(credential.sessionToken).digest("hex");
}
