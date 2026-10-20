/**
 * Ollama Cloud Provider Extension
 *
 * Registers Ollama Cloud as a model provider with a baked-in fallback catalog
 * and a native `refreshModels` callback that overlays live API updates.
 *
 * Setup:
 *   1. Get an API key from https://ollama.com
 *   2. Add to auth.json in the agent config dir (~/.pi/agent/auth.json, or set PI_CODING_AGENT_DIR):
 *      { "ollama-cloud": { "type": "api_key", "key": "your-key" } }
 *   3. Use /model or ctrl+l to select an Ollama Cloud model
 *
 * Two endpoints are used to build the model list:
 *   - GET  https://ollama.com/v1/models  -> list of model IDs
 *   - POST https://ollama.com/api/show   -> per-model details (capabilities, context length)
 *
 * Catalog behavior:
 *   - The baked-in GENERATED_MODELS list (via `npm run generate-models`) is the
 *     first-launch fallback when no persisted catalog exists.
 *   - On startup, /model open, and `pi update --models`, pi calls the
 *     `refreshModels` callback, which fetches the live catalog and persists it
 *     through pi's own FileModelsStore. Refresh is automatic.
 *
 * Only models with "tools" capability are registered.
 *
 * Accounts:
 *   - Pi's ollama-cloud credential is the `default` account; the /ollama settings panel adds
 *     more in ~/.pi/agent/ollama-cloud-accounts.json (auth.json format).
 *   - Each session keeps one account across restarts; new sessions take the next account
 *     in round-robin order. Usage-limit or rejected-key errors before a response starts
 *     move the session to the next account and resend the request.
 *   - Accounts holding purchased credits stop before their included usage runs out.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAccountRouter } from "./accounts/router.ts";
import { createSessionAccountBinding } from "./accounts/session.ts";
import { GENERATED_MODELS } from "./generated/catalog.generated.ts";
import { OLLAMA_BASE } from "./models/base.ts";
import { refreshOllamaCatalog } from "./models/catalog.ts";
import { createAccountStreamSimple } from "./pi/account-stream.ts";
import { registerSessionLifecycle } from "./pi/lifecycle.ts";

export default async function (pi: ExtensionAPI) {
  // Nothing here touches files or the network; stores load lazily on first use.
  const router = createAccountRouter();
  const binding = createSessionAccountBinding((customType, data) => pi.appendEntry(customType, data));
  pi.registerProvider("ollama-cloud", {
    name: "Ollama Cloud",
    baseUrl: `${OLLAMA_BASE}/v1`,
    apiKey: "$OLLAMA_API_KEY",
    api: "openai-completions",
    models: GENERATED_MODELS,
    refreshModels: refreshOllamaCatalog,
    streamSimple: createAccountStreamSimple({ router, binding }),
  });
  registerSessionLifecycle(pi, { router, binding });
}
