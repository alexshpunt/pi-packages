import { Effect, Exit } from "effect";
import { HttpBody, HttpClientRequest } from "effect/http";
import { startDeadline } from "../cancellation.ts";
import { RPCError, type DevinFailure } from "../errors.ts";
import { endpoint } from "../protocol/endpoint.ts";
import { discardResponse, fromHttpClientError, readBoundedJSON } from "../protocol/http.ts";
import { HttpTransport } from "../services/http-transport.ts";
import { failWith, object, requiredString } from "../validation.ts";

const TOKEN_PREFIX = "devin-session-token$";
const EXCHANGE_TIMEOUT_MS = 30_000;
const RESPONSE_BYTES = 64 * 1024;

/** REST authorization code exchange, same as the public client. Never resends or creates a refresh grant. */
export function exchangeBrowserCode(options: { origin: string; code: string; verifier: string }): Effect.Effect<string, DevinFailure, HttpTransport> {
  return Effect.scoped(Effect.gen(function* () {
    const origin = yield* endpoint(options.origin);
    const deadline = yield* startDeadline(EXCHANGE_TIMEOUT_MS);
    const http = yield* (yield* HttpTransport).open;
    return yield* deadline.guard(Effect.gen(function* () {
      const request = HttpClientRequest.post(`${origin}/auth/cli/token`).pipe(
        HttpClientRequest.setBody(HttpBody.raw(JSON.stringify({ code: options.code, code_verifier: options.verifier }))),
        HttpClientRequest.setHeaders({ "content-type": "application/json", accept: "application/json" }),
      );
      const response = yield* http.execute(request).pipe(Effect.mapError(fromHttpClientError));
      yield* Effect.addFinalizer((exit) => Exit.isSuccess(exit) ? Effect.void : discardResponse(response));
      if (response.status < 200 || response.status >= 300) {
        yield* discardResponse(response);
        return yield* Effect.fail(RPCError.make(response.status === 401 ? "unauthenticated" : `http_${response.status}`, "Devin login code exchange failed", response.status));
      }
      const body = yield* object(yield* readBoundedJSON(response, RESPONSE_BYTES), "Devin login response");
      const token = yield* requiredString(body.token, "Devin login response.token");
      if (/[\s\u0000-\u001f\u007f]/.test(token)) return yield* failWith("The token in the Devin login response has an invalid format.");
      return token.startsWith(TOKEN_PREFIX) ? token : TOKEN_PREFIX + token;
    }));
  }));
}
