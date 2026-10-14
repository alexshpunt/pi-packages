import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ModelCompactSetting, parseThresholdSetting } from "./thresholds.ts";

export interface ClaudeCompactConfig {
  /** Master switch for the engine (auto trigger and the Pi compaction takeover). */
  enabled: boolean;
  /** Background summary started before the threshold, reused when still valid (Claude Code's precompute). */
  precompute: boolean;
  /** "provider/modelId" of the summarizer, or null for the conversation model. */
  summaryModel: string | null;
  /** Retry with the conversation model when the configured summarizer fails. */
  fallbackToConversationModel: boolean;
  /** Keyed by exact "provider/modelId". */
  models: Record<string, ModelCompactSetting>;
}

export const DEFAULT_CONFIG: ClaudeCompactConfig = {
  enabled: true,
  precompute: false,
  summaryModel: null,
  fallbackToConversationModel: true,
  models: {},
};

export interface LoadedConfig {
  config: ClaudeCompactConfig;
  warnings: string[];
}

export function configPath(): string {
  return join(getAgentDir(), "claude-compact.json");
}

export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeModelSetting(key: string, raw: unknown, warnings: string[]): ModelCompactSetting | undefined {
  if (!isRecord(raw)) {
    warnings.push(`models["${key}"] is not an object; ignored`);
    return undefined;
  }
  const setting: ModelCompactSetting = {};
  if (raw.window !== undefined) {
    if (typeof raw.window === "number" && Number.isSafeInteger(raw.window) && raw.window > 0)
      setting.window = raw.window;
    else warnings.push(`models["${key}"].window must be a positive integer; ignored`);
  }
  if (raw.threshold !== undefined) {
    const value = raw.threshold;
    if ((typeof value === "number" || typeof value === "string") && parseThresholdSetting(value)) {
      setting.threshold = value;
    } else {
      warnings.push(`models["${key}"].threshold must be tokens (number, "367k") or a percent ("80%"); ignored`);
    }
  }
  return setting.window === undefined && setting.threshold === undefined ? undefined : setting;
}

export function sanitizeConfig(raw: unknown): LoadedConfig {
  const warnings: string[] = [];
  const config: ClaudeCompactConfig = { ...DEFAULT_CONFIG, models: {} };
  if (!isRecord(raw)) {
    if (raw !== undefined) warnings.push("config root is not an object; using defaults");
    return { config, warnings };
  }
  for (const flag of ["enabled", "precompute", "fallbackToConversationModel"] as const) {
    if (raw[flag] === undefined) continue;
    if (typeof raw[flag] === "boolean") config[flag] = raw[flag];
    else warnings.push(`${flag} must be a boolean; ignored`);
  }
  if (raw.summaryModel !== undefined) {
    if (raw.summaryModel === null) config.summaryModel = null;
    else if (typeof raw.summaryModel === "string" && /^[^/\s]+\/\S+$/.test(raw.summaryModel)) {
      config.summaryModel = raw.summaryModel;
    } else warnings.push('summaryModel must be null or "provider/modelId"; ignored');
  }
  if (raw.models !== undefined) {
    if (!isRecord(raw.models)) warnings.push("models must be an object; ignored");
    else {
      for (const [key, value] of Object.entries(raw.models)) {
        const setting = sanitizeModelSetting(key, value, warnings);
        if (setting) config.models[key] = setting;
      }
    }
  }
  return { config, warnings };
}

export function loadConfig(): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(configPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { config: { ...DEFAULT_CONFIG, models: {} }, warnings: [] };
    return {
      config: { ...DEFAULT_CONFIG, models: {} },
      warnings: [`cannot read ${configPath()}: ${(error as Error).message}`],
    };
  }
  try {
    return sanitizeConfig(JSON.parse(text));
  } catch (error) {
    return {
      config: { ...DEFAULT_CONFIG, models: {} },
      warnings: [`${configPath()} is not valid JSON (${(error as Error).message}); using defaults`],
    };
  }
}

export function saveConfig(config: ClaudeCompactConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
