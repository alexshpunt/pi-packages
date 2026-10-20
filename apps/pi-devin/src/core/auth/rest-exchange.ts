import { createHTTPTransport } from "../protocol/http.ts";
import { awaitWithSignal, boundedJSON, discardResponse, endpoint, RPCError } from "../protocol/transport.ts";
import { object, requiredString } from "../types.ts";

const TOKEN_PREFIX = "devin-session-token$";

/** REST authorization code exchange, same as the public client. Never resends or creates a refresh grant. */
export async function exchangeBrowserCode(options: {
  origin: string; code: string; verifier: string; signal: AbortSignal; fetch?: typeof fetch;
}): Promise<string> {
  const origin = endpoint(options.origin);
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const transport = options.fetch ? undefined : createHTTPTransport();
  try {
    const response = await awaitWithSignal((options.fetch ?? transport!.fetch)(`${origin}/auth/cli/token`, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code: options.code, code_verifier: options.verifier }),
    }), signal, discardResponse);
    if (!response.ok) {
      discardResponse(response);
      throw new RPCError(response.status === 401 ? "unauthenticated" : `http_${response.status}`, "Devin login code exchange failed", response.status);
    }
    let body: unknown;
    try { body = await boundedJSON(response, 64 * 1024, signal); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error("The Devin login response is not valid JSON.");
      throw error;
    }
    const token = requiredString(object(body, "Devin login response").token, "Devin login response.token");
    if (/[\s\u0000-\u001f\u007f]/.test(token)) throw new Error("The token in the Devin login response has an invalid format.");
    return token.startsWith(TOKEN_PREFIX) ? token : TOKEN_PREFIX + token;
  } finally { transport?.close(); }
}
