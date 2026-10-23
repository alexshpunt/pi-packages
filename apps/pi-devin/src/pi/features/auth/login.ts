import type { AuthInteraction, OAuthCredential } from "@earendil-works/pi-ai";
import { Context, Duration, Effect, Layer } from "effect";
import { loginAccount } from "../../../core/auth/login.ts";
import { abortWith } from "../../../core/cancellation.ts";
import { Cancelled, isTransientConnectionFailure, toDevinFailure } from "../../../core/errors.ts";
import { HttpTransport, type HttpTransportShape } from "../../../core/services/http-transport.ts";
import { failWith } from "../../../core/validation.ts";
import { ExtensionConfig } from "../../app/config.ts";
import { Accounts } from "../accounts/service.ts";
import { ModelCatalog } from "../catalog/service.ts";
import { DevinClients } from "../clients/service.ts";
import { ProviderLifetime } from "../lifetime/service.ts";
import { Runs } from "../runs/service.ts";
import { UsageChanges } from "../usage/changes.ts";
import { credentialFromOAuth, SESSION_CHECK_INTERVAL_MS } from "./credential.ts";
import { CredentialGuard } from "./guard.ts";
import { AuthState } from "./state.ts";
import type { AccountLoginShape } from "./types.ts";

/** Upper bound of the account check right after sign-in. Sign-in succeeds even when this check fails. */
const LOGIN_CHECK_TIMEOUT_MS = 15_000;

/** The transport of `/login` code exchanges, chosen by the environment like the provider's own transport. */
export class LoginTransport extends Context.Service<LoginTransport, HttpTransportShape>()("pi-devin/LoginTransport") {}

/** Pi's OAuth flows: sign-in, the periodic session check under Pi's credential lock, and request auth. */
export class AccountLogin extends Context.Service<AccountLogin, AccountLoginShape>()("pi-devin/AccountLogin") {}

/** A host prompt that is withdrawn, through its signal, when the waiting effect is interrupted. */
const prompt = <A>(request: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: request, catch: toDevinFailure });

export const AccountLoginLive = Layer.effect(AccountLogin, Effect.gen(function* () {
  const config = yield* ExtensionConfig;
  const auth = yield* AuthState;
  const accounts = yield* Accounts;
  const guard = yield* CredentialGuard;
  const catalog = yield* ModelCatalog;
  const clients = yield* DevinClients;
  const runs = yield* Runs;
  const changes = yield* UsageChanges;
  const lifetime = yield* ProviderLifetime;
  const transport = yield* LoginTransport;
  const now = config.now;

  /** Stops the work when the caller's signal or the provider lifetime current at the start of the host call ends, failing with that reason. */
  const stoppable = (signal: AbortSignal | undefined) => Effect.map(lifetime.current, (current) => <A, E>(effect: Effect.Effect<A, E>) =>
    current.guard(effect).pipe(abortWith(signal)));

  const signIn = (interaction: AuthInteraction) => Effect.gen(function* () {
    const choice = yield* prompt((signal) => interaction.prompt({ type: "select", signal, message: "Devin account sign-in method", options: [
      { id: "browser", label: "Browser sign-in", description: "Choose an account, then return through a loopback callback." },
      { id: "manual", label: "Manual authorization code", description: "Enter a one-time code using the Devin CLI manual flow. This is not an API key prompt." },
    ] }));
    if (choice !== "browser" && choice !== "manual") return yield* failWith("Unsupported Devin sign-in method.");
    const credential = yield* loginAccount({
      ...config.login, flow: choice,
      onURL: (url) => Effect.sync(() => interaction.notify({ type: "auth_url", url, instructions: "Return to the terminal after signing in. Signing in does not guarantee CLI access or quota." })),
      promptCode: prompt((signal) => interaction.prompt({ type: "manual_code", message: "Paste the authorization code or callback URL. Do not enter an API key or session token.", signal })),
    }).pipe(Effect.provideService(HttpTransport, transport));
    return { choice, credential };
  });

  /** A new session replaces everything learned from the previous one, in this order, before its own account is checked. */
  const replaceSession = Effect.all([
    accounts.clear, clients.clearFingerprints, catalog.invalidate,
    runs.abort(new Cancelled({ message: "The Devin account was re-authenticated." })), changes.publish,
  ], { discard: true });

  const login = (interaction: AuthInteraction) => Effect.gen(function* () {
    const stop = yield* stoppable(interaction.signal);
    const { choice, credential } = yield* stop(signIn(interaction));
    const generation = yield* auth.acceptLogin(credential);
    yield* replaceSession;
    // Records the new session's account and quota so the same account's model list and usage are available at once.
    // Sign-in is not a permission check: a failure here, including cancellation, is left to the first model request.
    yield* stop(accounts.check(credential, { expectedGeneration: generation })).pipe(
      Effect.timeoutOrElse({ duration: Duration.millis(LOGIN_CHECK_TIMEOUT_MS), orElse: () => Effect.void }),
      Effect.ignore,
    );
    interaction.notify({ type: "info", message: "Signed in to the Devin account. The server expiry time and refresh grant are unknown. If authentication fails, sign in again with /login." });
    return {
      type: "oauth", access: credential.sessionToken, refresh: "", expires: now() + SESSION_CHECK_INTERVAL_MS,
      devin: { version: 1, apiServerURL: credential.apiServerURL, createdAt: credential.createdAt, flow: choice },
    } satisfies OAuthCredential;
  });

  const usableCredential = (current: OAuthCredential) => Effect.gen(function* () {
    const credential = yield* credentialFromOAuth(current);
    yield* auth.assertUsable(credential);
    return yield* auth.rememberOAuth(credential);
  });

  const refresh = (current: OAuthCredential) => Effect.gen(function* () {
    const credential = yield* usableCredential(current);
    // Pi calls this while holding the shared auth.json lock once the check interval has passed, and saves the result.
    // The new expiry only schedules the next check; the token is never renewed.
    const checked = (): OAuthCredential => ({ ...current, expires: now() + SESSION_CHECK_INTERVAL_MS });
    // Model requests already check the account outside the lock, so a process that checked it does not wait on the network.
    if (yield* accounts.get(credential)) return checked();
    const expectedGeneration = yield* auth.generation;
    return yield* accounts.check(credential, { expectedGeneration }).pipe(
      Effect.map(checked),
      Effect.catch((error) => Effect.andThen(guard.reportFailure(credential, error, expectedGeneration),
        // An unreachable check must not block the request: keep the stored session unchanged so the model request
        // succeeds or reports its own retryable transport error, and the next use checks again.
        isTransientConnectionFailure(error) ? Effect.succeed(current) : Effect.fail(error))),
    );
  });

  return {
    login,
    refresh: (current, signal) => Effect.flatMap(stoppable(signal), (stop) => stop(refresh(current))),
    // apiKey is only ModelAuth's transport field; the sign-in/storage auth type is always oauth.
    toAuth: (current) => Effect.map(usableCredential(current), (credential) => ({ apiKey: credential.sessionToken, baseUrl: credential.apiServerURL })),
  } satisfies AccountLoginShape;
}));
