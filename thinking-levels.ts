/**
 * Thinking level mapping for Ollama Cloud models.
 *
 * Maps Pi's thinking levels to Ollama Cloud's OpenAI-compatible
 * `reasoning_effort` values. The API accepts "none", "low", "medium", "high",
 * "xhigh", "ultra", and "max". On simple prompts, "max" can be a no-op over
 * "high", but on harder prompts it can increase thinking substantially.
 *
 * The per-model level support comes from models.dev: scripts/generate-reasoning.ts
 * fetches the `ollama-cloud` provider's `reasoning_options` into
 * reasoning.generated.ts (the same data source pi uses for its built-in
 * providers), and resolve() maps a model's effort values onto Pi's levels.
 *
 * The API exposes only a boolean `thinking` capability plus a global effort
 * vocabulary, and models.dev does not reliably encode the `none` behavior, so
 * the `off` switch is handled separately: it defaults to "none" (a live probe
 * of the current catalog confirmed every model except the OFF_NULL overrides
 * below honors it), and models verified not to honor `none` pin it to null
 * (hidden) via OFF_NULL.
 *
 * A `null` value means the level is hidden in Pi's UI.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { MODEL_REASONING_OPTIONS, type ModelsDevReasoningOption } from "./reasoning.generated.ts";

export type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

/** Default: off/low/medium/high/xhigh with minimal hidden. */
export const DEFAULT: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

/**
 * Models where a live probe of `reasoning_effort:"none"` still produced
 * reasoning (i.e. thinking cannot be disabled), so the `off` level is hidden.
 * Confirmed against the current catalog by scripts/../test probing; the API
 * and models.dev do not expose this behavior.
 */
const OFF_NULL = new Set(["gpt-oss:20b", "gpt-oss:120b", "minimax-m2.7"]);

/**
 * Map a models.dev `effort` value onto the Pi level key and the reasoning_effort
 * string to send for it. Ollama's top effort value is "max"; Pi exposes it via
 * the extra-high level, so "max" (and "xhigh"/"ultra") map to the xhigh key.
 */
const EFFORT_TO_LEVEL: Record<string, { key: "minimal" | "low" | "medium" | "high" | "xhigh"; value: string }> = {
  minimal: { key: "minimal", value: "minimal" },
  low: { key: "low", value: "low" },
  medium: { key: "medium", value: "medium" },
  high: { key: "high", value: "high" },
  xhigh: { key: "xhigh", value: "xhigh" },
  max: { key: "xhigh", value: "max" },
  ultra: { key: "xhigh", value: "ultra" },
};
/**
 * Build a ThinkingLevelMap from models.dev reasoning_options.
 * Levels come from `effort` values (mapped via EFFORT_TO_LEVEL); `off` defaults
 * to "none" (probe-derived, see file header) and is hidden only via OFF_NULL.
 * A toggle-only model is binary (on/off) and exposes a single "medium" level.
 */
function buildMap(options: readonly ModelsDevReasoningOption[], id: string): ThinkingLevelMap {
  const map: ThinkingLevelMap = {
    off: OFF_NULL.has(id) ? null : "none",
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
  };

  if (options.every((option) => option.type === "toggle")) {
    // Binary on/off model: no graded effort, expose a single level.
    return { ...map, medium: "medium" };
  }

  const efforts = options.flatMap((option) => (option.type === "effort" ? (option.values ?? []) : []));
  for (const effort of efforts) {
    const target = effort !== null && effort !== "default" ? EFFORT_TO_LEVEL[effort] : undefined;
    if (target) map[target.key] = target.value;
  }
  return map;
}

/**
 * Resolve the thinking level map for a model.
 * Looks up the model id (exact, then `:tag` family) in the generated models.dev
 * table, falling back to DEFAULT for models with no entry.
 */
export function resolve(id: string, capabilities: string[]): ThinkingLevelMap | undefined {
  if (!capabilities.includes("thinking")) return undefined;

  const colon = id.lastIndexOf(":");
  const options = MODEL_REASONING_OPTIONS[id] ?? (colon > 0 ? MODEL_REASONING_OPTIONS[id.slice(0, colon)] : undefined);
  if (options === undefined) return DEFAULT;
  return buildMap(options, id);
}
