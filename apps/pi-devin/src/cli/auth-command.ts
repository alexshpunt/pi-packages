import { loginAccount, type LoginOptions } from "../core/auth/index.ts";
import { safeError } from "../core/protocol/transport.ts";
import { credentialPath, saveCredential } from "./credentials.ts";
import { openLoginURL, readAuthorizationCode } from "./auth-ui.ts";
import type { Credential, JsonObject } from "../core/types.ts";

export async function loginCommand(
  options: Omit<LoginOptions, "onURL" | "promptCode"> & { noBrowser?: boolean },
  ui: {
    emit: (event: string, data: JsonObject) => void;
    onCredential: (credential: Credential) => void;
    openURL?: typeof openLoginURL;
    promptCode?: typeof readAuthorizationCode;
  },
): Promise<void> {
  const { noBrowser, ...loginOptions } = options;
  const credential = await loginAccount({
    ...loginOptions,
    promptCode: ui.promptCode ?? (options.flow === "manual" || process.stdin.isTTY ? readAuthorizationCode : undefined),
    onURL: async (url, signal) => {
      ui.emit("auth_url", { url });
      if (noBrowser) return;
      try { await (ui.openURL ?? openLoginURL)(url, signal); }
      catch (error) {
        signal.throwIfAborted();
        ui.emit("browser_open_failed", { message: safeError(error) });
      }
    },
  });
  ui.onCredential(credential);
  await saveCredential(credential);
  ui.emit("logged_in", { credentialFile: credentialPath(), apiServerURL: credential.apiServerURL, createdAt: credential.createdAt });
}
