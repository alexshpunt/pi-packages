import type { ModelsDevReasoningOption } from "../generated/catalog.generated.ts";
import { MODEL_PRICING, type ModelPrice } from "../generated/catalog.generated.ts";
import { MODEL_MAX_OUTPUT_TOKENS } from "../generated/limits.generated.ts";

import { getContextLength } from "./context-length.ts";
import { resolveThinkingMetadata, type ThinkingMetadata } from "./thinking-levels.ts";
import { type ChatModelConfig, isOllamaShowResponse } from "./types.ts";

export interface ModelMetadataSources {
  pricing?: Readonly<Record<string, ModelPrice>>;
  maxOutputTokens?: Readonly<Record<string, number>>;
  reasoning?: Readonly<Record<string, ModelsDevReasoningOption[]>>;
}

// --- Pricing ---
// Per-1M-token prices are generated from the ollama.com/pricing model table by
// scripts/generate-pricing.ts (see ../generated/catalog.generated.ts, do not edit by hand).
// Ollama Cloud is subscription-billed; these are equivalent pay-as-you-go
// rates so /cost shows comparable usage, not actual charges.

/** Resolve the price for an Ollama Cloud model ID. Exact match only;
 *  unmapped models return zero. */
function resolvePrice(id: string, pricing: Readonly<Record<string, ModelPrice>>): ModelPrice {
  return Object.hasOwn(pricing, id) ? pricing[id] : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

// --- Max output tokens ---
// Per-model limits are probed against the live API by scripts/generate-limits.ts
// (see ../generated/limits.generated.ts, do not edit by hand). /api/show does not expose the
// limit, so models without a probed value fall back to 32768.

/** Resolve the max output tokens for an Ollama Cloud model ID. Exact match only;
 *  unmapped models fall back to 32768. */
function resolveMaxTokens(id: string, limits: Readonly<Record<string, number>>): number {
  return Object.hasOwn(limits, id) ? limits[id] : 32768;
}
// --- Assembly: raw API data -> ProviderModelConfig[] ---

/**
 * Build an explicit OpenAICompletionsCompat for an Ollama Cloud model.
 * Every flag is set explicitly so the contract is visible to maintainers.
 *
 * Ollama API reference: https://docs.ollama.com/api/openai-compatibility
 * pi type definition: https://github.com/earendil-works/pi/blob/b94482762321ed0b9f8f245be57c84d786a7105d/packages/ai/src/types.ts#L361-L400
 * pi compat resolution:  https://docs.ollama.com/api/openai-compatibility https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts#L365-L425
 */
function buildCompat(): ChatModelConfig["compat"] {
  return {
    // Ollama uses "system" role, not "developer" (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsDeveloperRole).
    supportsDeveloperRole: false,
    // reasoning_effort works (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsReasoningEffort).
    supportsReasoningEffort: true,
    // "store" is not a supported field (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsStore).
    supportsStore: false,
    // Ollama lists "max_tokens", not "max_completion_tokens" (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#maxTokensField).
    maxTokensField: "max_tokens",
    // stream_options.include_usage is supported (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsUsageInStreaming).
    supportsUsageInStreaming: true,
    // Default: tool results don't need a name field (pi: types.ts#requiresToolResultName).
    requiresToolResultName: false,
    // Default: no assistant message required between tool result and user (pi: types.ts#requiresAssistantAfterToolResult).
    requiresAssistantAfterToolResult: false,
    // Ollama supports native thinking blocks (pi: types.ts#requiresThinkingAsText).
    requiresThinkingAsText: false,
    // DeepSeek-specific, not needed for Ollama (pi: types.ts#requiresReasoningContentOnAssistantMessages).
    requiresReasoningContentOnAssistantMessages: false,
    // reasoning_effort format works (pi: types.ts#thinkingFormat).
    thinkingFormat: "openai",
    // Ollama does not support tool_choice, so strict mode is unavailable (ollama: docs.ollama.com/api/openai-compatibility, pi: types.ts#supportsStrictMode).
    supportsStrictMode: false,
    // Session affinity headers not relevant for Ollama (pi: types.ts#sendSessionAffinityHeaders).
    sendSessionAffinityHeaders: false,
    // No explicit cache-retention API (pi: types.ts#supportsLongCacheRetention).
    supportsLongCacheRetention: false,
    // Not z.ai (pi: types.ts#zaiToolStream).
    zaiToolStream: false,
    // Anthropic cache_control not relevant; Ollama has implicit KV cache only (pi: types.ts#cacheControlFormat).
    // Explicitly undefined: JSON.stringify drops undefined values, keeping
    // catalog.generated.ts structurally consistent with assembleModels() runtime output.
    cacheControlFormat: undefined,
    // OpenRouter / Vercel AI Gateway routing prefs. pi-ai's OpenAI transport
    // truthiness-checks the raw model.compat (not the resolved getCompat() value)
    // and forwards it verbatim: `if (model.compat?.openRouterRouting)
    // params.provider = ...` in packages/ai/src/api/openai-completions.ts. `{}` is
    // truthy, so baking it in sent a stray `provider: {}` on every Ollama request.
    // Express "none" as undefined, never `{}`; undefined is falsy at the wire site
    // and JSON.stringify drops it from catalog.generated.ts. The boolean flags above
    // stay explicit `false` on purpose: omitting a boolean makes getCompat() fall
    // back to detectCompat's generic-OpenAI defaults, which are wrong for Ollama
    // (e.g. maxTokensField -> "max_completion_tokens", supportsStrictMode -> true).
    openRouterRouting: undefined,
    vercelGatewayRouting: undefined,
  };
}

export interface ModelMetadata {
  requestedId: string;
  metadataId: string;
  capabilities: string[];
  isChatCandidate: boolean;
  exclusionReason?: string;
  contextWindow: number;
  maxTokens: number;
  cost: ModelPrice;
  sources: {
    contextWindow: "api" | "fallback";
    maxTokens: "generated" | "fallback";
    price: "generated" | "unknown";
    thinking: ThinkingMetadata["source"];
  };
  thinking: ThinkingMetadata;
}

/** No suffix/date heuristics: an accepted alias is not proof of equal pricing or output limits. */
export function resolveModelMetadata(
  requestedId: string,
  raw: unknown,
  sources: ModelMetadataSources = {},
): ModelMetadata {
  const pricing = sources.pricing ?? MODEL_PRICING;
  const limits = sources.maxOutputTokens ?? MODEL_MAX_OUTPUT_TOKENS;
  if (!isOllamaShowResponse(raw)) {
    throw new Error(
      `Invalid /api/show response for ${requestedId}: expected string capabilities and model_info object.`,
    );
  }
  const hasContextLength = Object.entries(raw.model_info ?? {}).some(
    ([key, value]) =>
      key.endsWith(".context_length") && typeof value === "number" && Number.isInteger(value) && value > 0,
  );
  const thinking = resolveThinkingMetadata(requestedId, raw.capabilities, raw.thinking, sources.reasoning);
  const isChatCandidate = raw.capabilities.includes("tools");
  return {
    requestedId,
    metadataId: requestedId,
    capabilities: [...raw.capabilities],
    isChatCandidate,
    ...(!isChatCandidate ? { exclusionReason: "Model does not support tool calling." } : {}),
    contextWindow: getContextLength(raw.model_info ?? {}),
    maxTokens: resolveMaxTokens(requestedId, limits),
    cost: resolvePrice(requestedId, pricing),
    sources: {
      contextWindow: hasContextLength ? "api" : "fallback",
      maxTokens: Object.hasOwn(limits, requestedId) ? "generated" : "fallback",
      price: Object.hasOwn(pricing, requestedId) ? "generated" : "unknown",
      thinking: thinking.source,
    },
    thinking,
  };
}

export function assembleModels(raw: Record<string, unknown>, sources: ModelMetadataSources = {}): ChatModelConfig[] {
  return Object.entries(raw).flatMap(([id, data]) => {
    const metadata = resolveModelMetadata(id, data, sources);
    if (!metadata.isChatCandidate) return [];
    return [
      {
        id,
        name: id,
        reasoning: metadata.capabilities.includes("thinking"),
        thinkingLevelMap: metadata.thinking.map,
        input: (metadata.capabilities.includes("vision") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
        cost: metadata.cost,
        contextWindow: metadata.contextWindow,
        maxTokens: metadata.maxTokens,
        compat: buildCompat(),
      },
    ];
  });
}
