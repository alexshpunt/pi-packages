import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const CATALOG_FILE = join(dirname(fileURLToPath(import.meta.url)), "reasoning-models.json");

export type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

type CatalogPattern = {
  match: string;
  map: ThinkingLevelMap;
};

type ThinkingCatalog = {
  version: number;
  default: ThinkingLevelMap;
  models?: Record<string, ThinkingLevelMap>;
  patterns?: CatalogPattern[];
};

type ThinkingModelData = {
  capabilities?: string[];
  details?: { family?: string };
};

const BINARY_THINKING_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: null,
  medium: "medium",
  high: null,
  xhigh: null,
};

function normalizeThinkingMap(partial: Partial<ThinkingLevelMap>): ThinkingLevelMap {
  const map: ThinkingLevelMap = { ...BINARY_THINKING_MAP };
  for (const level of PI_THINKING_LEVELS) {
    if (level in partial) {
      map[level] = partial[level] ?? null;
    }
  }
  return map;
}

function readThinkingCatalog(): ThinkingCatalog {
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_FILE, "utf-8")) as Partial<ThinkingCatalog>;
    const defaultMap = normalizeThinkingMap(parsed.default ?? {});
    const models: Record<string, ThinkingLevelMap> = {};
    for (const [id, map] of Object.entries(parsed.models ?? {})) {
      models[id] = normalizeThinkingMap(map);
    }
    const patterns: CatalogPattern[] = (parsed.patterns ?? []).map((p) => ({
      match: p.match,
      map: normalizeThinkingMap(p.map),
    }));
    return {
      version: parsed.version ?? 1,
      default: defaultMap,
      models,
      patterns,
    };
  } catch {
    return { version: 1, default: BINARY_THINKING_MAP, models: {}, patterns: [] };
  }
}

const THINKING_CATALOG = readThinkingCatalog();

function normalize(value: string): string {
  return value.toLowerCase();
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export function resolveThinkingLevelMap(
  modelId: string,
  data: ThinkingModelData,
): ProviderModelConfig["thinkingLevelMap"] {
  if (!data.capabilities?.includes("thinking")) return undefined;

  const normalizedModelId = normalize(modelId);
  const exact = THINKING_CATALOG.models?.[normalizedModelId] ?? THINKING_CATALOG.models?.[modelId];
  if (exact) return exact;

  const family = data.details?.family ? normalize(data.details.family) : undefined;
  for (const entry of THINKING_CATALOG.patterns ?? []) {
    if (globMatches(entry.match, normalizedModelId) || (family && globMatches(entry.match, family))) {
      return entry.map;
    }
  }

  return THINKING_CATALOG.default;
}

export function formatThinkingLevelsForLog(model: ProviderModelConfig): string {
  if (!model.reasoning) return "off";
  const map = model.thinkingLevelMap ?? {};
  return PI_THINKING_LEVELS.filter((level) => map[level] !== null).join(",");
}
