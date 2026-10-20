import type { ModelPrice, ModelsDevReasoningOption } from "../../../src/generated/catalog.generated.ts";
import { MODEL_MAX_OUTPUT_TOKENS } from "../../../src/generated/limits.generated.ts";
import { collectModelDetails, fetchModelDetails, fetchModelIds } from "../../../src/models/api.ts";
import { assembleModels, resolveModelMetadata } from "../../../src/models/metadata.ts";
import { type ChatModelConfig, isOllamaShowResponse } from "../../../src/models/types.ts";
import { isSafeModelId, parsePricingRows, parseReasoningOptions } from "./parsers.ts";

export const PRICING_URL = "https://ollama.com/pricing";
export const MODELS_DEV_URL = "https://models.dev/api.json";
const SOURCE_TIMEOUT_MS = 15000;
export interface GenerationSources {
  list(signal?: AbortSignal): Promise<string[]>;
  detail(id: string, signal?: AbortSignal): Promise<unknown>;
  pricing(signal?: AbortSignal): Promise<string>;
  reasoning(signal?: AbortSignal): Promise<unknown>;
}
async function readSource(url: string, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    if (!response.ok) throw new Error(`Generation source request failed (${response.status}).`);
    const result = await response.text();
    signal?.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
  }
}
const sources: GenerationSources = {
  list: fetchModelIds,
  detail: fetchModelDetails,
  pricing: (signal) => readSource(PRICING_URL, signal),
  reasoning: async (signal) => {
    const raw = await readSource(MODELS_DEV_URL, signal);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error("models.dev response is not JSON.");
    }
  },
};
export interface GeneratedCatalogInfo {
  schemaVersion: 1;
  generatedAt: string;
  candidateIds: string[];
  nativeThinkingIds: string[];
  unknownPricingIds: string[];
  unknownLimitIds: string[];
  sources: {
    cloud: { url: string; observedAt: string | null };
    pricing: { url: string; observedAt: string | null; tier: "standard" };
    reasoning: { url: string; observedAt: string | null };
    limits: "existing measurements; not reprobed";
  };
  notes: string[];
}
export interface GeneratedCatalog {
  models: ChatModelConfig[];
  pricing: Record<string, ModelPrice>;
  reasoning: Record<string, ModelsDevReasoningOption[]>;
  info: GeneratedCatalogInfo;
}
export interface CollectCatalogOptions {
  sources?: GenerationSources;
  limits?: Readonly<Record<string, number>>;
  signal?: AbortSignal;
  clock?: () => string;
}
export async function collectCatalog(options: CollectCatalogOptions = {}): Promise<GeneratedCatalog> {
  const input = options.sources ?? sources;
  const limits = options.limits ?? MODEL_MAX_OUTPUT_TOKENS;
  const signal = options.signal;
  const clock = options.clock ?? (() => new Date().toISOString());
  signal?.throwIfAborted();
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0))
    throw new Error("Invalid existing output limits.");
  const ids = await input.list(signal);
  if (!ids.length || ids.some((id) => !isSafeModelId(id)) || new Set(ids).size !== ids.length)
    throw new Error("Empty, duplicate or invalid model candidate list; keeping the previous snapshot.");
  const details = await collectModelDetails(ids, signal, async (id, callerSignal) => {
    const value = await input.detail(id, callerSignal);
    if (!isOllamaShowResponse(value)) throw new Error("Invalid model detail response shape.");
    return value;
  });
  signal?.throwIfAborted();
  if (details.failures.length || Object.keys(details.models).length !== ids.length)
    throw new Error(`Incomplete model details (${details.failures.length} failed); keeping the previous snapshot.`);
  const cloudAt = clock();
  const parsedPricing = parsePricingRows(await input.pricing(signal));
  const pricingAt = clock();
  const allReasoning = parseReasoningOptions(await input.reasoning(signal));
  const reasoningAt = clock();
  signal?.throwIfAborted();
  const pricing = Object.fromEntries(
    ids.flatMap((id) => {
      const price = parsedPricing.prices.get(id);
      return price ? [[id, price] as const] : [];
    }),
  );
  const reasoning: Record<string, ModelsDevReasoningOption[]> = {};
  for (const id of ids) {
    const colon = id.lastIndexOf(":");
    const family = colon > 0 ? id.slice(0, colon) : "";
    const key = Object.hasOwn(allReasoning, id) ? id : Object.hasOwn(allReasoning, family) ? family : undefined;
    if (key !== undefined) reasoning[key] = allReasoning[key];
  }
  const metadataSources = { pricing, reasoning, maxOutputTokens: limits };
  const metadata = ids.map((id) => resolveModelMetadata(id, details.models[id], metadataSources));
  if (metadata.some((entry) => entry.thinking.warnings.length > 0))
    throw new Error("Unrecognized native thinking metadata; keeping the previous snapshot.");
  const models = assembleModels(details.models, metadataSources).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  if (!models.length) throw new Error("No chat candidates; keeping the previous snapshot.");
  if (!models.some((model) => Object.hasOwn(pricing, model.id)))
    throw new Error("No exact standard price matches for chat candidates; review source identity/schema.");
  return {
    models,
    pricing,
    reasoning,
    info: {
      schemaVersion: 1,
      generatedAt: clock(),
      candidateIds: [...ids].sort(),
      nativeThinkingIds: metadata
        .filter((entry) => entry.isChatCandidate && entry.thinking.source === "api")
        .map((entry) => entry.requestedId)
        .sort(),
      unknownPricingIds: metadata
        .filter((entry) => entry.isChatCandidate && entry.sources.price === "unknown")
        .map((entry) => entry.requestedId)
        .sort(),
      unknownLimitIds: metadata
        .filter((entry) => entry.isChatCandidate && entry.sources.maxTokens === "fallback")
        .map((entry) => entry.requestedId)
        .sort(),
      sources: {
        cloud: { url: "https://ollama.com", observedAt: cloudAt },
        pricing: { url: PRICING_URL, observedAt: pricingAt, tier: "standard" },
        reasoning: { url: MODELS_DEV_URL, observedAt: reasoningAt },
        limits: "existing measurements; not reprobed",
      },
      notes: [
        "Unknown prices are omitted, not declared free; aliases/date tags do not inherit prices or limits.",
        `Input-only pricing rows: ${parsedPricing.unpricedRows.length}; off-peak rows not applied: ${parsedPricing.offPeakRows.length}.`,
      ],
    },
  };
}
