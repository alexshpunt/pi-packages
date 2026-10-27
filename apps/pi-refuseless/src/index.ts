/**
 * Refuseless provider: `/login` → Refuseless asks for an API key, Pi stores it, and `/model` lists the
 * models `GET /v1/models` returns for that key. Pi fetches the list after login and when `/model` opens,
 * and keeps the last one for offline starts. Requests use Pi's OpenAI chat-completions implementation.
 * Picking a model in a session that had no thinking level starts it at the model's `reasoning_default`.
 * Registration makes no network call, so login is available before a key exists.
 */

import { type ApiKeyAuth, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchRefuselessModels, REFUSELESS_BASE_URL, REFUSELESS_PROVIDER_ID } from "./models.ts";
import { registerThinkingDefault } from "./thinking.ts";

/**
 * Pi's standard key login. The entered key is trimmed, and an empty entry fails the login so that pressing
 * Enter on a blank prompt cannot replace a saved key.
 */
function apiKeyAuth(): ApiKeyAuth {
  const standard = envApiKeyAuth("Refuseless API key", ["REFUSELESS_API_KEY"]);
  const login = standard.login!;
  return {
    ...standard,
    login: async (interaction) => {
      const credential = await login(interaction);
      const key = credential.key?.trim();
      if (!key) throw new Error("API key is empty");
      return { ...credential, key };
    },
  };
}

export default function refuseless(pi: ExtensionAPI) {
  pi.registerProvider(
    createProvider({
      id: REFUSELESS_PROVIDER_ID,
      name: "Refuseless",
      baseUrl: REFUSELESS_BASE_URL,
      auth: { apiKey: apiKeyAuth() },
      models: [],
      fetchModels: fetchRefuselessModels,
      api: openAICompletionsApi(),
    }),
  );
  registerThinkingDefault(pi);
}
