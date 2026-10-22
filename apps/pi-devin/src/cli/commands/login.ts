import { Effect } from "effect";
import { loginAccount, type LoginOptions } from "../../core/auth/index.ts";
import type { DevinFailure } from "../../core/errors.ts";
import { safeError } from "../../core/redaction.ts";
import type { HttpTransport } from "../../core/services/http-transport.ts";
import { LoginUI } from "../services/login-ui.ts";
import { CLIOutput } from "../services/output.ts";
import { StateFiles } from "../services/state-files.ts";

/** Browser or manual sign-in, then saves the session to this PoC's own credential file. */
export function loginCommand(options: Omit<LoginOptions, "onURL" | "promptCode"> & { noBrowser?: boolean }): Effect.Effect<void, DevinFailure, CLIOutput | StateFiles | LoginUI | HttpTransport> {
  return Effect.gen(function* () {
    const { noBrowser, ...loginOptions } = options;
    const output = yield* CLIOutput;
    const files = yield* StateFiles;
    const ui = yield* LoginUI;
    const credential = yield* loginAccount({
      ...loginOptions,
      promptCode: options.flow === "manual" || ui.canPrompt ? ui.promptCode : undefined,
      onURL: (url) => Effect.gen(function* () {
        yield* output.emit("auth_url", { url });
        if (noBrowser) return;
        yield* ui.openURL(url).pipe(Effect.catch((error) => output.emit("browser_open_failed", { message: safeError(error) })));
      }),
    });
    yield* output.setSecret(credential.sessionToken);
    yield* files.saveCredential(credential);
    yield* output.emit("logged_in", { credentialFile: files.credentialPath, apiServerURL: credential.apiServerURL, createdAt: credential.createdAt });
  });
}
