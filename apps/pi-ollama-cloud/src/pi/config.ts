/**
 * Configuration loader for pi-ollama-cloud.
 *
 * Reads settings from JSON config files with project-over-global precedence:
 *   - ~/.pi/agent/ollama-cloud.json (global / user-level)
 *   - .pi/ollama-cloud.json        (project-local, takes precedence)
 *
 * Environment variables serve as overrides above both config files:
 *   - PI_OLLAMA_WEB_TOOLS=0  disables web tool registration
 *
 * The /ollama settings panel writes its toggles to the global file only.
 *
 * Example ollama-cloud.json:
 * ```json
 * {
 *   "webTools": false
 * }
 * ```
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// --- Types ---

export interface OllamaCloudConfig {
  /** When false, ollama_web_search and ollama_web_fetch tools are not registered. Default: true. */
  webTools?: boolean;
  /** When true, the footer usage status bar is shown. Default: false (opt-in; enable in /ollama). */
  usageStatus?: boolean;
}

// --- Defaults ---

const DEFAULT_CONFIG: OllamaCloudConfig = {
  webTools: true,
  usageStatus: false,
};

// --- Validation ---

/** Allowed config keys and their expected types for runtime validation. */
const CONFIG_SCHEMA: Record<keyof OllamaCloudConfig, "boolean"> = {
  webTools: "boolean",
  usageStatus: "boolean",
};

/**
 * Validate a parsed JSON object against the known schema.
 * Unknown keys are silently dropped; values with wrong types fall back to undefined.
 */
function sanitizeConfig(raw: Record<string, unknown>): OllamaCloudConfig {
  const out: OllamaCloudConfig = {};
  for (const [key, expectedType] of Object.entries(CONFIG_SCHEMA)) {
    const value = raw[key];
    if (typeof value === expectedType) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

// --- Loader ---

export function globalConfigPath(): string {
  return join(getAgentDir(), "ollama-cloud.json");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "ollama-cloud.json");
}

function readConfigFile(path: string): OllamaCloudConfig {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    // Silently skip files that parse to null, arrays, or primitives —
    // malformed config should not crash the extension (defaults apply).
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return sanitizeConfig(parsed as Record<string, unknown>);
    }
  } catch (err) {
    console.error(`[pi-ollama-cloud] Failed to load config from ${path}: ${err}`);
  }
  return {};
}

export interface ConfigLayers {
  global: OllamaCloudConfig;
  project: OllamaCloudConfig;
  projectPath: string;
}

/** The global and project files separately, so callers can tell which one decides a value. */
export function readConfigLayers(cwd: string): ConfigLayers {
  const projectPath = projectConfigPath(cwd);
  return { global: readConfigFile(globalConfigPath()), project: readConfigFile(projectPath), projectPath };
}

/**
 * Merge settings into the global config file, keeping keys this version does not
 * know. An unreadable file is never overwritten. Returns the file path.
 */
export function saveGlobalConfig(patch: OllamaCloudConfig): string {
  const path = globalConfigPath();
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      throw new Error(`${path} is not valid JSON; fix or remove it before saving settings.`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${path} must contain a JSON object; fix or remove it before saving settings.`);
    }
    current = parsed as Record<string, unknown>;
  }
  const next = { ...current, ...patch };
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode });
    renameSync(temporary, path);
  } catch (error) {
    throw new Error(`Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}

/**
 * Load configuration from JSON files.
 * Project-local config overrides global config.
 * Environment variables override both.
 */
export function loadConfig(cwd: string): OllamaCloudConfig {
  const layers = readConfigLayers(cwd);

  // Merge with defaults: defaults < global < project
  const merged: OllamaCloudConfig = {
    ...DEFAULT_CONFIG,
    ...layers.global,
    ...layers.project,
  };

  // Environment variable overrides (only webTools for now)
  const envOverride = resolveWebToolsEnv();
  if (envOverride !== undefined) {
    merged.webTools = envOverride;
  }

  return merged;
}

/**
 * Resolve the PI_OLLAMA_WEB_TOOLS environment variable override.
 * Returns undefined when not set (no override),
 * true/false when explicitly set.
 */
export function resolveWebToolsEnv(): boolean | undefined {
  const raw = process.env.PI_OLLAMA_WEB_TOOLS;
  if (raw === undefined) return undefined;

  const lowered = raw.toLowerCase();
  if (["0", "false", "no", "off", ""].includes(lowered)) return false;
  // Treat any other non-empty value as "enabled"
  return true;
}
