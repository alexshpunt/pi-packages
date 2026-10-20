import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
/**
 * Resolve the Ollama Cloud API key for a tool execution or command.
 *
 * Prefers the canonical provider auth chain (ctx.modelRegistry.getApiKeyForProvider),
 * which honors runtime/CLI key overrides, the registered
 * apiKey: "$OLLAMA_API_KEY" config, and stored auth.json credentials. Falls back
 * to the OLLAMA_API_KEY env var for the case where the provider is not yet
 * registered at call time.
 */
export async function getCloudApiKey(ctx: Pick<ExtensionContext, "modelRegistry">): Promise<string | undefined> {
  return (await ctx.modelRegistry.getApiKeyForProvider("ollama-cloud")) ?? process.env.OLLAMA_API_KEY;
}
