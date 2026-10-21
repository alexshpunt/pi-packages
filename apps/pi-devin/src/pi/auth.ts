import { createHash } from "node:crypto";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { loginAccount, type LoginOptions } from "../core/auth/index.ts";
import { DevinClient } from "../core/client.ts";
import { awaitWithSignal, endpoint, isAuthenticationError, isTransientConnectionFailure, RPCError } from "../core/protocol/transport.ts";
import { object, requiredString, type Credential, type JsonObject } from "../core/types.ts";

export const OAUTH_ONLY_MESSAGE = "Devin uses only the OAuth account session from /login. API key authentication is not supported.";
/**
 * Pi checks the stored session again after this interval. It is not a server TTL: the server expiry is unknown, no new token
 * is issued, and each model request still checks the account outside Pi's credential lock.
 */
export const SESSION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Upper bound of the account check right after sign-in. Sign-in succeeds even when this check fails. */
const LOGIN_CHECK_TIMEOUT_MS = 15_000;

export interface DevinAccountAuth extends OAuthAuth {
  readonly generation: number;
  assertUsable(credential: Credential): void;
  /** Converts the OAuth credential stored by Pi into the shared credential and remembers it as this process's OAuth session. */
  credentialFromHost(credential: OAuthCredential): Credential;
  /** Rejects sessions that did not come from an OAuth login or stored credential (API keys etc.) before any network request. */
  assertOAuthSession(credential: Credential): void;
  /** Remembers only authentication failures confirmed in the same auth generation. The credential file is never deleted. */
  invalidate(credential: Credential, error: unknown, generation: number): void;
}

export function credentialFromOAuth(credential: OAuthCredential): Credential {
  // 0.1.4 and earlier stored `expires: 0`; Pi checks such a session again on its next use.
  if (credential.type !== "oauth" || credential.refresh !== "" || !Number.isSafeInteger(credential.expires) || credential.expires < 0) {
    throw new Error("Unsupported Devin account credential. Sign in again with /login.");
  }
  const metadata = object(credential.devin, "Devin credential metadata");
  if (metadata.version !== 1) throw new Error("The Devin account credential version differs. Sign in again with /login.");
  return {
    version: 1,
    sessionToken: requiredString(credential.access, "Devin credential access"),
    apiServerURL: endpoint(requiredString(metadata.apiServerURL, "Devin credential API server")),
    createdAt: requiredString(metadata.createdAt, "Devin credential creation time"),
  };
}

function credentialKey(credential: Credential): string {
  return createHash("sha256").update(credential.apiServerURL + "\0" + credential.sessionToken).digest("hex");
}

/** Endpoint mismatches are rejected separately by the model list scope. This only checks that the session came from OAuth. */
function sessionKey(credential: Credential): string {
  return createHash("sha256").update(credential.sessionToken).digest("hex");
}

export function createDevinAccountAuth(options: {
  loginOptions?: Omit<LoginOptions, "onURL" | "promptCode" | "signal" | "flow" | "encoding">;
  createClient?: (credential: Credential) => DevinClient;
  onLogin?: () => void;
  onValidated?: (credential: Credential, ownerHash: string, status: JsonObject) => void;
  onInvalidated?: (credential: Credential, error: unknown) => void;
  getSignal?: () => AbortSignal;
  /** The account was already checked in this process; each model request checks it again outside Pi's credential lock. */
  isAccountChecked?: (credential: Credential) => boolean;
  now?: () => number;
} = {}): DevinAccountAuth {
  const now = options.now ?? Date.now;
  const invalid = new Set<string>();
  // Remembers only a hash, never the token. Pi calls toAuth on every request, so the session in use moves back to the front.
  const oauthSessions = new Set<string>();
  let generation = 0;
  const requireUsable = (credential: Credential) => {
    if (invalid.has(credentialKey(credential))) throw new RPCError("unauthenticated", "Authentication failed for this session. Sign in again with /login.");
  };
  const rememberOAuth = (credential: Credential) => {
    const key = sessionKey(credential);
    oauthSessions.delete(key);
    if (oauthSessions.size >= 64) oauthSessions.delete(oauthSessions.values().next().value!);
    oauthSessions.add(key);
    return credential;
  };
  const checkAccount = async (credential: Credential, signal: AbortSignal, expectedGeneration: number) => {
    const client = (options.createClient ?? ((value) => new DevinClient(value, { profile: "login" })))(credential);
    try {
      const status = await client.status(signal);
      if (expectedGeneration === generation) options.onValidated?.(credential, requiredString(client.accountIdentityHash, "Devin account scope"), status);
    } finally { client.transport.close(); }
  };
  const auth: DevinAccountAuth = {
    name: "Devin account",
    get generation() { return generation; },
    assertUsable: requireUsable,
    credentialFromHost: (current) => rememberOAuth(credentialFromOAuth(current)),
    assertOAuthSession(credential) {
      // Kept as a plain error so it does not invalidate authentication or cancel a running request.
      if (!oauthSessions.has(sessionKey(credential))) throw new Error(OAUTH_ONLY_MESSAGE);
    },
    async login(interaction) {
      const lifetime = options.getSignal?.();
      const signal = AbortSignal.any([interaction.signal, ...(lifetime ? [lifetime] : [])]);
      signal.throwIfAborted();
      const choice = await awaitWithSignal(interaction.prompt({ type: "select", signal, message: "Devin account sign-in method", options: [
        { id: "browser", label: "Browser sign-in", description: "Choose an account, then return through a loopback callback." },
        { id: "manual", label: "Manual authorization code", description: "Enter a one-time code using the Devin CLI manual flow. This is not an API key prompt." },
      ] }), signal);
      if (choice !== "browser" && choice !== "manual") throw new Error("Unsupported Devin sign-in method.");
      const credential = await loginAccount({
        ...options.loginOptions, flow: choice, signal,
        onURL: (url) => interaction.notify({ type: "auth_url", url, instructions: "Return to the terminal after signing in. Signing in does not guarantee CLI access or quota." }),
        promptCode: (signal) => interaction.prompt({ type: "manual_code", message: "Paste the authorization code or callback URL. Do not enter an API key or session token.", signal }),
      });
      signal.throwIfAborted();
      invalid.delete(credentialKey(credential));
      rememberOAuth(credential);
      generation++;
      options.onLogin?.();
      // Records the new session's account and quota so the same account's model list and usage are available at once.
      // Sign-in is not a permission check: a failure here is left to the first model request.
      if (options.onValidated) {
        try { await checkAccount(credential, AbortSignal.any([signal, AbortSignal.timeout(LOGIN_CHECK_TIMEOUT_MS)]), generation); }
        catch { /* best effort */ }
      }
      interaction.notify({ type: "info", message: "Signed in to the Devin account. The server expiry time and refresh grant are unknown. If authentication fails, sign in again with /login." });
      return {
        type: "oauth", access: credential.sessionToken, refresh: "", expires: now() + SESSION_CHECK_INTERVAL_MS,
        devin: { version: 1, apiServerURL: credential.apiServerURL, createdAt: credential.createdAt, flow: choice },
      };
    },
    async refresh(current, callerSignal) {
      const lifetime = options.getSignal?.();
      const signal = AbortSignal.any([callerSignal, ...(lifetime ? [lifetime] : [])]);
      signal.throwIfAborted();
      const credential = credentialFromOAuth(current);
      requireUsable(credential);
      rememberOAuth(credential);
      // Pi calls this while holding the shared auth.json lock once the check interval has passed, and saves the result.
      // The new expiry only schedules the next check; the token is never renewed.
      const checked = (): OAuthCredential => ({ ...current, expires: now() + SESSION_CHECK_INTERVAL_MS });
      // Model requests already check the account outside the lock, so a process that checked it does not wait on the network.
      if (options.isAccountChecked?.(credential)) return checked();
      const expectedGeneration = generation;
      try {
        await checkAccount(credential, signal, expectedGeneration);
        return checked();
      } catch (error) {
        auth.invalidate(credential, error, expectedGeneration);
        // An unreachable check must not block the request: keep the stored session unchanged so the model request
        // succeeds or reports its own retryable transport error, and the next use checks again.
        if (!signal.aborted && isTransientConnectionFailure(error)) return current;
        throw error;
      }
    },
    async toAuth(current) {
      const credential = credentialFromOAuth(current);
      requireUsable(credential);
      rememberOAuth(credential);
      // apiKey is only ModelAuth's transport field; the sign-in/storage auth type is always oauth.
      return { apiKey: credential.sessionToken, baseUrl: credential.apiServerURL };
    },
    invalidate(credential, error, expectedGeneration) {
      if (expectedGeneration !== generation || !isAuthenticationError(error)) return;
      const key = credentialKey(credential);
      if (invalid.has(key)) return;
      if (invalid.size >= 64) invalid.delete(invalid.values().next().value!);
      invalid.add(key);
      options.onInvalidated?.(credential, error);
    },
  };
  return auth;
}
