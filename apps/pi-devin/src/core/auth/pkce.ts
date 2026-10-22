import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PKCE_CODE_PREFIX = "wspkce$";

export interface PKCE { verifier: string; challenge: string; state: string }

export function createPKCE(): PKCE {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  };
}

/** The code the exchange RPC expects: a Windsurf-style code without its prefix. */
export function codeForExchange(code: string): string {
  return code.startsWith(PKCE_CODE_PREFIX) ? code.slice(PKCE_CODE_PREFIX.length) : code;
}

export function matchesState(received: string | null, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A one-time authorization code. API keys, session tokens and credentials of other schemes are refused. */
export function isAuthorizationCode(code: string): boolean {
  return code.length > 0 && code.length <= 8192 && codeForExchange(code).length > 0
    && !/[\s\u0000-\u001f\u007f]/.test(code)
    && !/^(devin-session-token\$|cog_|sk-ws-01-|Bearer |Basic )/.test(code);
}
