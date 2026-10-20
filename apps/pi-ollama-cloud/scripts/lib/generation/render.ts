import type { GeneratedCatalog } from "./catalog.ts";
import type { GeneratedLimits } from "./limits.ts";

const preferred = ["id", "name"];
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => {
          const ai = preferred.indexOf(a);
          const bi = preferred.indexOf(b);
          if (ai >= 0 || bi >= 0) return (ai < 0 ? preferred.length : ai) - (bi < 0 ? preferred.length : bi);
          return a < b ? -1 : a > b ? 1 : 0;
        })
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}
export const stableJSON = (value: unknown) => JSON.stringify(canonical(value), null, 2);
export function renderLimits(result: GeneratedLimits): string {
  return [
    "// Auto-generated verified output limits. Existing values survive indeterminate probes.",
    `export const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = ${stableJSON(result.limits)};`,
    `export const LIMIT_MEASUREMENT_INFO = ${stableJSON(result.info)};`,
    "",
  ].join("\n");
}
export function renderCatalog(catalog: GeneratedCatalog): string {
  return [
    "// Auto-generated as one complete catalog snapshot. Do not edit data manually.",
    `import type { ChatModelConfig } from ${JSON.stringify("../models/types.ts")};`,
    "export interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite: number; }",
    'export type ModelsDevReasoningOption = { type: "toggle" } | { type: "effort"; values: Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "default" | null> };',
    `export const GENERATED_MODELS: ChatModelConfig[] = ${stableJSON(catalog.models)};`,
    `export const MODEL_PRICING: Record<string, ModelPrice> = ${stableJSON(catalog.pricing)};`,
    `export const MODEL_REASONING_OPTIONS: Record<string, ModelsDevReasoningOption[]> = ${stableJSON(catalog.reasoning)};`,
    `export const GENERATED_CATALOG_INFO = ${stableJSON(catalog.info)};`,
    "",
  ].join("\n");
}
