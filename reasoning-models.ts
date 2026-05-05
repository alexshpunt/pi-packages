import type { ThinkingLevelMap } from "./thinking.ts";

/**
 * Thinking-level catalog for Ollama Cloud models.
 *
 * Maps Pi's six thinking levels (off, minimal, low, medium, high, xhigh) to
 * Ollama Cloud reasoning_effort values. A `null` value means the level is not
 * supported and Pi will not offer it.
 *
 * Rules are sourced from:
 *   - https://docs.ollama.com/capabilities/thinking (official thinking docs)
 *   - Per-model library pages
 *   - Manual testing where docs are silent
 *
 * The default map assumes binary on/off (most thinking models). Explicit
 * per-model or per-family entries override it.
 */

export interface CatalogPattern {
  match: string;
  map: ThinkingLevelMap;
}

export interface ThinkingCatalog {
  version: number;
  default: ThinkingLevelMap;
  models: Record<string, ThinkingLevelMap>;
  patterns: CatalogPattern[];
}

const BINARY: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: null,
  medium: "medium",
  high: null,
  xhigh: null,
};

export const CATALOG: ThinkingCatalog = {
  version: 2,

  // Conservative default: binary on/off. Most thinking models don't document
  // gradations. Falls back to "medium" as the single "on" level.
  default: BINARY,

  // Per-model overrides (exact ID match, takes precedence over patterns).
  models: {
    // https://ollama.com/library/deepseek-v4-pro
    // Three reasoning modes, maps all Pi levels.
    "deepseek-v4-pro": {
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    },
  },

  // Glob patterns matched against model ID and details.family (case-insensitive).
  // Entries are checked in order; first match wins.
  patterns: [
    // https://docs.ollama.com/capabilities/thinking
    // GPT-OSS only accepts low/medium/high. No off mode.
    // https://ollama.com/library/gpt-oss
    {
      match: "gpt-oss*",
      map: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
      },
    },

    // https://docs.ollama.com/capabilities/thinking
    // Qwen 3.x uses boolean think flag. Treated as binary on/off.
    // Covers: qwen3, qwen3.5, qwen3.6, qwen3-next, qwen3-vl
    // https://ollama.com/library/qwen3
    {
      match: "qwen3*",
      map: BINARY,
    },

    // https://docs.ollama.com/capabilities/thinking
    // DeepSeek v3.1 and R1 documented as boolean. v4-flash and v3.2 assumed
    // binary. deepseek-v4-pro has an exact-match override above.
    // https://ollama.com/library/deepseek-v3.1
    // https://ollama.com/library/deepseek-r1
    {
      match: "deepseek*",
      map: BINARY,
    },

    // Assumed binary — no gradation docs found.
    // https://ollama.com/library/gemma4
    { match: "gemma*", map: BINARY },

    // https://ollama.com/library/glm-5.1
    { match: "glm*", map: BINARY },

    // https://ollama.com/library/kimi-k2.6
    { match: "kimi*", map: BINARY },

    // https://ollama.com/library/minimax-m2.7
    { match: "minimax*", map: BINARY },

    // https://ollama.com/library/mistral-medium-3.5
    { match: "mistral*", map: BINARY },

    // https://ollama.com/library/nemotron3
    { match: "nemotron*", map: BINARY },

    // https://ollama.com/library/laguna-xs.2
    { match: "laguna*", map: BINARY },

    // https://ollama.com/library/magistral
    { match: "magistral*", map: BINARY },

    // https://ollama.com/library/gemini-3-flash-preview
    { match: "gemini*", map: BINARY },
  ],
};
