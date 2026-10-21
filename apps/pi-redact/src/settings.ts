import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createRedactor,
  formatIssue,
  normalizeRedactionConfig,
  type RedactionConfig,
  RedactionConfigError,
  type RedactionExceptionConfig,
  type RedactionRuleConfig,
  type Redactor,
} from "@buyong/redact";

export const SETTINGS_DIRECTORY = "pi-redact";
const SETTINGS_FILE = "settings.json";

export function globalSettingsPath(agentDir: string): string {
  return join(agentDir, SETTINGS_DIRECTORY, SETTINGS_FILE);
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", SETTINGS_DIRECTORY, SETTINGS_FILE);
}

export interface LoadedSettings {
  /** Built-in rules plus every valid settings layer. */
  readonly redactor: Redactor;
  /** Settings files that contributed to the redactor. */
  readonly sources: readonly string[];
  /** Reasons a file was skipped. They name keys and indexes, never configured patterns or values. */
  readonly problems: readonly string[];
}

type LayerRead = { readonly config?: RedactionConfig; readonly problems: readonly string[] };

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** One settings file. Any problem skips the whole file rather than applying part of it. */
async function readLayer(path: string): Promise<LayerRead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { problems: [] };
    return { problems: [`${path}: could not be read`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON.parse messages quote the file, which can contain exception values.
    return { problems: [`${path}: is not valid JSON`] };
  }
  const { config, issues } = normalizeRedactionConfig(parsed);
  if (issues.length) return { problems: issues.map((issue) => `${path}: ${formatIssue(issue)}`) };
  return { config, problems: [] };
}

function unique<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const value of values) byKey.set(keyOf(value), value);
  return [...byKey.values()];
}

/** Later layers add fields, exceptions, and entities, and replace rules that share an id. */
export function mergeRedactionConfigs(layers: readonly RedactionConfig[]): RedactionConfig {
  const all = <T>(pick: (layer: RedactionConfig) => readonly T[] | undefined) =>
    layers.flatMap((layer) => pick(layer) ?? []);
  return {
    sensitiveFields: unique(
      all((layer) => layer.sensitiveFields),
      (field) => field,
    ),
    rules: unique<RedactionRuleConfig>(
      all((layer) => layer.rules),
      (rule) => rule.id,
    ),
    exceptions: unique<RedactionExceptionConfig>(
      all((layer) => layer.exceptions),
      (exception) => `${exception.ruleId}\u0000${exception.value}`,
    ),
    piiEntities: unique(
      all((layer) => layer.piiEntities),
      (entity) => entity,
    ),
  };
}

/** Load global settings and, in a trusted project, project settings; invalid input falls back to built-in rules. */
export async function loadSettings(options: {
  readonly agentDir: string;
  readonly cwd: string;
  readonly isProjectTrusted: boolean;
}): Promise<LoadedSettings> {
  const problems: string[] = [];
  const sources: string[] = [];
  const layers: RedactionConfig[] = [];
  const paths = [globalSettingsPath(options.agentDir)];
  const projectPath = projectSettingsPath(options.cwd);
  if (options.isProjectTrusted) paths.push(projectPath);
  else if (await isFile(projectPath)) problems.push(`${projectPath}: ignored because the project is not trusted`);

  for (const path of paths) {
    const layer = await readLayer(path);
    problems.push(...layer.problems);
    if (layer.config) {
      layers.push(layer.config);
      sources.push(path);
    }
  }
  try {
    return { redactor: createRedactor(mergeRedactionConfigs(layers)), sources, problems };
  } catch (error) {
    const issues = error instanceof RedactionConfigError ? error.issues.map(formatIssue) : ["could not be applied"];
    problems.push(...issues.map((issue) => `merged settings: ${issue}; using built-in rules`));
    return { redactor: createRedactor(), sources: [], problems };
  }
}
