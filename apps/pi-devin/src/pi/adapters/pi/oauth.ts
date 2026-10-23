import type { OAuthAuth } from "@earendil-works/pi-ai";
import type { ProviderRuntime } from "../../app/runtime.ts";
import { AccountLogin } from "../../features/auth/login.ts";

/** Pi's OAuth contract over the sign-in service. Promises reject with the original failure, so Pi sees its name and message. */
export function makeOAuthAuth(runtime: ProviderRuntime): OAuthAuth {
  const accountLogin = runtime.runSync(AccountLogin);
  return {
    name: "Devin account",
    login: (interaction) => runtime.runPromise(accountLogin.login(interaction)),
    refresh: (current, signal) => runtime.runPromise(accountLogin.refresh(current, signal)),
    toAuth: (current) => runtime.runPromise(accountLogin.toAuth(current)),
  };
}
