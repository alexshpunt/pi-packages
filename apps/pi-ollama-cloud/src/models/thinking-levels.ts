/**
 * Thinking level mapping for Ollama Cloud models.
 *
 * Maps Pi's thinking levels to Ollama Cloud's OpenAI-compatible
 * `reasoning_effort` values. The API accepts "minimal", "none", "low",
 * "medium", "high", "xhigh", "ultra", and "max". On simple prompts, "max" can
 * be a no-op over "high", but on harder prompts it can increase thinking
 * substantially.
 *
 * Every value EFFORT_TO_LEVEL can send was verified against the live chat
 * completions API (2026-09-11: "minimal", "xhigh", and "ultra" probed across
 * gpt-oss, deepseek-v4, glm, minimax, and qwen thinking models, all accepted
 * with graded reasoning), so a future models.dev row that lists them passes
 * through a value the endpoint demonstrably accepts.
 *
 * Live /api/show thinking.values is preferred. Official OpenAI compatibility
 * maps named efforts to those names and "none" to false. Unknown values are
 * diagnosed, not forwarded. Generated models.dev options remain the fallback
 * for older snapshots without metadata. Verified OFF_NULL overrides still win.
 * Reference: https://docs.ollama.com/api/openai-compatibility
 * The server default is diagnostic only; it never replaces a caller's choice.
 *
 * A `null` value means the level is hidden in Pi's UI.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { MODEL_REASONING_OPTIONS, type ModelsDevReasoningOption } from "../generated/catalog.generated.ts";

type ChatModelConfig =
  Extract<ProviderModelConfig, { type?: "chat" }> extends never
    ? ProviderModelConfig
    : Extract<ProviderModelConfig, { type?: "chat" }>;

export type ThinkingLevelMap = NonNullable<ChatModelConfig["thinkingLevelMap"]>;

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
/**
 * Models where a live probe of `reasoning_effort:"none"` still produced
 * reasoning (i.e. thinking cannot be disabled), so the `off` level is hidden.
 * Confirmed against the current catalog by scripts/../test probing; the API
 * and models.dev do not expose this behavior.
 *
 * Exact ids hide only the named variant; family prefixes cover future model
 * revisions in the same family. gpt-oss is a family-wide prefix because both
 * probed variants leak and the behavior is documented for the family.
 * minimax is NOT matched family-wide here: minimax-m3 was probed to honor
 * `none`, so only the verified-leaking minimax-m2.7 is pinned by exact id.
 */
const OFF_NULL_EXACT = new Set(["minimax-m2.7"]);
const OFF_NULL_FAMILIES = ["gpt-oss"];

function hidesOff(id: string): boolean {
  return OFF_NULL_EXACT.has(id) || OFF_NULL_FAMILIES.some((prefix) => id.startsWith(prefix));
}

function applyOffRestriction(id: string, map: ThinkingLevelMap): ThinkingLevelMap {
  return hidesOff(id) ? { ...map, off: null } : map;
}

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
 * to "none" (probe-derived, see file header) and is hidden only via the
 * OFF_NULL exact/family sets (see hidesOff).
 * A toggle-only model is binary (on/off) and exposes a single "medium" level.
 */
function buildMap(options: readonly ModelsDevReasoningOption[], id: string): ThinkingLevelMap {
  const map: ThinkingLevelMap = {
    off: hidesOff(id) ? null : "none",
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
  };

  if (options.length > 0 && options.every((option) => option.type === "toggle")) {
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
 * Read MODEL_REASONING_OPTIONS[id] without tripping over inherited keys (e.g.
 * "constructor"), which would otherwise resolve to the Object constructor and
 * crash buildMap.
 */
function ownOptions(
  id: string,
  generated: Readonly<Record<string, ModelsDevReasoningOption[]>>,
): ModelsDevReasoningOption[] | undefined {
  return Object.hasOwn(generated, id) ? generated[id] : undefined;
}

/**
 * Resolve the thinking level map for a model.
 * Looks up the model id (exact, then `:tag` family) in the generated models.dev
 * table, falling back to DEFAULT for models with no entry. The matched key is
 * the one passed to buildMap so the OFF_NULL set (keyed on bare family names)
 * applies to tagged ids that resolve through a family match.
 */
function resolveGeneratedThinking(
  id: string,
  capabilities: string[],
  generated: Readonly<Record<string, ModelsDevReasoningOption[]>>,
): ThinkingMetadata {
  if (!capabilities.includes("thinking")) return { map: undefined, source: "unsupported", warnings: [] };

  const colon = id.lastIndexOf(":");
  const exact = ownOptions(id, generated);
  const matchedKey = exact !== undefined ? id : colon > 0 ? id.slice(0, colon) : "";
  const options = exact ?? ownOptions(matchedKey, generated);
  // An empty array (e.g. minimax-m2.5) carries no verified options; fall back
  // to DEFAULT rather than a degenerate map whose only selectable level can
  // be a leaking off.
  if (options === undefined || options.length === 0) {
    return { map: applyOffRestriction(id, DEFAULT), source: "fallback", warnings: [] };
  }
  return { map: buildMap(options, matchedKey), source: "generated", warnings: [] };
}

export interface ThinkingMetadata {
  map: ThinkingLevelMap | undefined;
  source: "api" | "generated" | "fallback" | "unsupported";
  nativeValues?: (string | boolean)[];
  nativeDefault?: string | boolean;
  warnings: string[];
}

export function resolveThinkingMetadata(
  id: string,
  capabilities: string[],
  native?: unknown,
  generated: Readonly<Record<string, ModelsDevReasoningOption[]>> = MODEL_REASONING_OPTIONS,
): ThinkingMetadata {
  const fallback = resolveGeneratedThinking(id, capabilities, generated);
  if (native === undefined || !capabilities.includes("thinking")) return fallback;
  if (native === null || typeof native !== "object" || Array.isArray(native)) {
    return { ...fallback, warnings: ["Invalid thinking metadata; using fallback."] };
  }
  const { values, default: defaultValue } = native as Record<string, unknown>;
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((v) => typeof v !== "boolean" && typeof v !== "string") ||
    (defaultValue !== undefined && typeof defaultValue !== "boolean" && typeof defaultValue !== "string")
  ) {
    return { ...fallback, warnings: ["Invalid thinking values/default; using fallback."] };
  }
  const map: ThinkingLevelMap = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };
  const mapping: Record<string, keyof ThinkingLevelMap> = {
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    ultra: "max",
    max: "max",
  };
  const warnings: string[] = [];
  for (const [effort, level] of Object.entries(mapping)) if (values.includes(effort)) map[level] = effort;
  // Preserve the package's established xhigh -> max compatibility alias when
  // the model has max but no separate xhigh effort.
  if (map.max !== null && map.xhigh === null) map.xhigh = map.max;
  if (values.includes(true) && !values.some((value) => typeof value === "string")) map.medium = "medium";
  if (values.includes(false) && fallback.map?.off !== null) map.off = "none";
  for (const value of values) {
    if (typeof value === "string" && !Object.hasOwn(mapping, value)) warnings.push(`Unknown thinking value: ${value}`);
  }
  if (Object.entries(map).every(([level, value]) => level === "off" || value === null)) {
    return { ...fallback, warnings: [...warnings, "No verified enabled effort; using fallback."] };
  }
  return {
    map,
    source: "api",
    nativeValues: values,
    ...(defaultValue !== undefined ? { nativeDefault: defaultValue } : {}),
    warnings,
  };
}

/** Existing two-argument callers keep generated/fallback semantics. */
export function resolve(id: string, capabilities: string[], native?: unknown): ThinkingLevelMap | undefined {
  return resolveThinkingMetadata(id, capabilities, native).map;
}
