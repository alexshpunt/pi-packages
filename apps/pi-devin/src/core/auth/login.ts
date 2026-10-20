import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { awaitWithSignal, ConnectClient, endpoint, RPCError, safeError } from "../protocol/transport.ts";
import { requiredString, type Credential } from "../types.ts";
import { exchangeBrowserCode } from "./rest-exchange.ts";

export const DEFAULT_API_SERVER_URL = "https://server.codeium.com";
export const DEFAULT_WEBAPP_URL = "https://app.devin.ai";
export const DEFAULT_DEVIN_API_URL = "https://api.devin.ai";
const EXCHANGE_METHOD = "exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode";
const PKCE_EXCHANGE_METHOD = "exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode";
const PKCE_CODE_PREFIX = "wspkce$";
const codeForExchange = (code: string) => code.startsWith(PKCE_CODE_PREFIX) ? code.slice(PKCE_CODE_PREFIX.length) : code;
export type LoginFlow = "browser" | "manual" | "legacy-connect";
export interface LoginOptions {
  apiServerURL?: string;
  webappURL?: string;
  devinAPIURL?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onURL: (url: string, signal: AbortSignal) => void | Promise<void>;
  /** Receives a one-time authorization code, never an API key or session token. */
  promptCode?: (signal: AbortSignal) => Promise<string>;
  fetch?: typeof fetch;
  encoding?: "proto" | "json";
  flow?: LoginFlow;
}

export function createPKCE(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  };
}

function matchesState(received: string | null, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isAuthorizationCode(code: string): boolean {
  return code.length > 0 && code.length <= 8192 && codeForExchange(code).length > 0
    && !/[\s\u0000-\u001f\u007f]/.test(code)
    && !/^(devin-session-token\$|cog_|sk-ws-01-|Bearer |Basic )/.test(code);
}

/** The new account UI defaults to the REST browser flow. An explicit encoding keeps the legacy Connect path. */
export function loginAccount(options: LoginOptions): Promise<Credential> {
  return login({ ...options, flow: options.flow ?? (options.encoding === undefined ? "browser" : "legacy-connect") });
}

/** Keeps the default Connect contract of the existing shared login(). Storage and opening the browser belong to the caller. */
export async function login(options: LoginOptions): Promise<Credential> {
  const flow = options.flow ?? "legacy-connect";
  if (!["browser", "manual", "legacy-connect"].includes(flow)) throw new Error("Unsupported login flow.");
  if (options.encoding !== undefined && options.encoding !== "proto" && options.encoding !== "json") throw new Error("The login encoding must be proto or json.");
  if (flow === "browser" && options.encoding !== undefined) throw new Error("A Connect encoding cannot be used with the REST browser login.");
  if (flow !== "browser" && options.devinAPIURL !== undefined) throw new Error("The Devin REST login server can only be set for the REST browser flow.");
  if (flow === "manual" && !options.promptCode) throw new Error("Manual login requires an authorization code prompt.");
  const apiServerURL = endpoint(options.apiServerURL ?? DEFAULT_API_SERVER_URL);
  const webappURL = endpoint(options.webappURL ?? DEFAULT_WEBAPP_URL);
  const devinAPIURL = endpoint(options.devinAPIURL ?? DEFAULT_DEVIN_API_URL);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 300_000)]);
  signal.throwIfAborted();
  const pkce = createPKCE();
  if (flow !== "legacy-connect") pkce.state = randomUUID();
  let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void;
  let hasAcceptedCode = false, authorizationCode = "";
  let client: ConnectClient | undefined;
  let redirectURL: string | undefined;
  const inputController = new AbortController();
  const inputSignal = AbortSignal.any([signal, inputController.signal]);
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  void codePromise.catch(() => {});
  const acceptCode = (code: string) => {
    if (hasAcceptedCode || !isAuthorizationCode(code)) return false;
    hasAcceptedCode = true;
    authorizationCode = code;
    resolveCode(code);
    inputController.abort(new DOMException("Authorization code received.", "AbortError"));
    return true;
  };
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://127.0.0.1"); }
    catch { response.writeHead(400).end("Invalid callback URL"); return; }
    if (request.method !== "GET" || url.pathname !== "/callback") { response.writeHead(404).end("Not found"); return; }
    if (hasAcceptedCode || !matchesState(url.searchParams.get("state"), pkce.state)) { response.writeHead(400).end("Invalid OAuth state"); return; }
    if (url.searchParams.has("error")) {
      hasAcceptedCode = true;
      response.writeHead(400).end("Login was denied.");
      rejectCode(new Error("OAuth login was denied."));
      inputController.abort();
      return;
    }
    if (!acceptCode(url.searchParams.get("code") ?? "")) { response.writeHead(400).end("Missing authorization code"); return; }
    response.end("Authorization code received. Check the token exchange result in your terminal.");
  });
  const onAbort = () => rejectCode(new DOMException(
    signal.reason?.name === "TimeoutError" ? "OAuth login timed out." : "OAuth login was cancelled.",
    signal.reason?.name === "TimeoutError" ? "TimeoutError" : "AbortError",
  ));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (flow !== "manual") {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Could not determine the callback port.");
      redirectURL = `http://127.0.0.1:${address.port}/callback`;
    }
    const authorizationURL = new URL(flow === "manual" ? "/devin/account/login" : "/auth/cli/continue", webappURL);
    authorizationURL.search = new URLSearchParams({
      redirect_uri: flow === "manual" ? "chisel-show-auth-token" : redirectURL!,
      state: pkce.state,
      ...(flow === "manual" ? {} : { prompt: "select_account" }),
      code_challenge: pkce.challenge, code_challenge_method: "S256",
    }).toString();
    signal.throwIfAborted();
    await awaitWithSignal(Promise.resolve(options.onURL(authorizationURL.href, signal)), signal);
    if (options.promptCode && !hasAcceptedCode) {
      void awaitWithSignal(Promise.resolve().then(() => options.promptCode!(inputSignal)), inputSignal).then((value) => {
        if (hasAcceptedCode || signal.aborted) return;
        authorizationCode = value.trim(); // Also keeps the raw code out of errors.
        let code = authorizationCode;
        if (/^https?:\/\//.test(code)) {
          const pasted = new URL(code);
          if (!redirectURL || pasted.origin + pasted.pathname !== redirectURL || !matchesState(pasted.searchParams.get("state"), pkce.state)) {
            throw new Error("The pasted callback URL or state does not match.");
          }
          code = pasted.searchParams.get("code") ?? "";
        }
        if (!acceptCode(code)) throw new Error("Enter a valid authorization code. API keys and session tokens are not accepted.");
      }).catch((error) => { if (!hasAcceptedCode && !signal.aborted) rejectCode(error); });
    }
    authorizationCode = await codePromise;
    signal.throwIfAborted();
    let sessionToken: string;
    if (flow === "browser") {
      sessionToken = await exchangeBrowserCode({ origin: devinAPIURL, code: authorizationCode, verifier: pkce.verifier, signal, fetch: options.fetch });
    } else {
      client = new ConnectClient({ baseURL: apiServerURL, timeoutMs: 30_000, fetch: options.fetch });
      const isWindsurfCode = authorizationCode.startsWith(PKCE_CODE_PREFIX);
      const method = isWindsurfCode ? PKCE_EXCHANGE_METHOD : EXCHANGE_METHOD;
      const body = isWindsurfCode ? { authorizationCode: codeForExchange(authorizationCode), codeVerifier: pkce.verifier }
        : { code: authorizationCode, codeVerifier: pkce.verifier };
      const exchanged = await client.unary(method, body, signal, { encoding: options.encoding ?? "proto" });
      if (isWindsurfCode && typeof exchanged.apiServerUrl === "string" && exchanged.apiServerUrl && endpoint(exchanged.apiServerUrl) !== apiServerURL) {
        throw new Error("The login returned a different API server. Set the target with --api-server-url and sign in again.");
      }
      const tokenField = isWindsurfCode ? "apiKey" : "sessionToken";
      sessionToken = requiredString(exchanged[tokenField], `${method}.${tokenField}`);
    }
    return { version: 1, sessionToken, apiServerURL, createdAt: new Date().toISOString() };
  } catch (error) {
    const secrets = [authorizationCode, codeForExchange(authorizationCode), pkce.verifier];
    if (error instanceof RPCError) { error.message = safeError(error, secrets); error.code = safeError(error.code, secrets); throw error; }
    const failure = new Error(safeError(error, secrets));
    if (error instanceof Error) failure.name = error.name;
    throw failure;
  } finally {
    inputController.abort();
    client?.close();
    signal.removeEventListener("abort", onAbort);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
