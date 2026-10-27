import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BUILT_IN_RULE_IDS,
  createRedactor,
  EMPTY_REDACTION_CONFIG,
  formatIssue,
  type NormalizedRedactionConfig,
  normalizeRedactionConfig,
  PRIVATE_KEY_RULE_ID,
  type RedactionConfig,
  RedactionConfigError,
  type RedactionExceptionConfig,
  type RedactionRuleConfig,
  type Redactor,
  SENSITIVE_FIELD_RULE_ID,
} from "@buyong/redact";
import { Data, Effect } from "effect";

export const SETTINGS_DIRECTORY = "pi-redact";
const SETTINGS_FILE = "settings.json";

/** Built-in rules that `disabledRules` can turn off, in catalog order. */
export const SWITCHABLE_RULE_IDS: readonly string[] = Object.freeze([
  ...BUILT_IN_RULE_IDS,
  PRIVATE_KEY_RULE_ID,
  SENSITIVE_FIELD_RULE_ID,
]);

/** Keys pi-redact reads itself; they weaken masking, so only the global file may set them. */
const GLOBAL_ONLY_KEYS = ["enabled", "disabledRules"] as const;

export function globalSettingsPath(agentDir: string): string {
  return join(agentDir, SETTINGS_DIRECTORY, SETTINGS_FILE);
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", SETTINGS_DIRECTORY, SETTINGS_FILE);
}

export type SettingsScope = "global" | "project";

/** One settings file's contents after validation. */
export interface SettingsDocument {
  /** `false` turns masking off by default; only the global file may set it. */
  readonly enabled: boolean;
  /** Built-in rule ids that are not applied; only the global file may set them. */
  readonly disabledRules: readonly string[];
  readonly config: NormalizedRedactionConfig;
}

export const EMPTY_SETTINGS_DOCUMENT: SettingsDocument = Object.freeze({
  enabled: true,
  disabledRules: Object.freeze([]),
  config: EMPTY_REDACTION_CONFIG,
});

export type SettingsFileState =
  | { readonly state: "missing" }
  | { readonly state: "valid"; readonly document: SettingsDocument }
  /** Problems name keys and indexes, never configured patterns or values. */
  | { readonly state: "invalid"; readonly problems: readonly string[] };

export interface SettingsLocation {
  readonly agentDir: string;
  readonly cwd: string;
  readonly isProjectTrusted: boolean;
}

/** One settings file's validated contents and whether the current project may edit it. */
export interface CustomTarget {
  readonly scope: SettingsScope;
  readonly path: string;
  readonly file: SettingsFileState;
  readonly unavailableReason?: string;
}

export class SettingsError extends Data.TaggedError("SettingsError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface LoadedSettings {
  /** Built-in rules plus every valid settings layer. */
  readonly redactor: Redactor;
  /** Built-in rule ids the global settings turned off. */
  readonly disabledRules: readonly string[];
  /** The global default for masking; `true` unless the global file sets `enabled: false`. */
  readonly isEnabledByDefault: boolean;
  /** Settings files that contributed to the redactor. */
  readonly sources: readonly string[];
  /** Reasons a file was skipped. They name keys and indexes, never configured patterns or values. */
  readonly problems: readonly string[];
}

function settingsIO<A>(operation: () => Promise<A>): Effect.Effect<A, SettingsError> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => new SettingsError({ message: cause instanceof Error ? cause.message : String(cause), cause }),
  });
}

function isFile(path: string): Effect.Effect<boolean> {
  return settingsIO(() => stat(path)).pipe(
    Effect.map((info) => info.isFile()),
    Effect.catch(() => Effect.succeed(false)),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate parsed JSON for one scope. Any problem rejects the whole document rather than part of it. */
export function parseSettingsDocument(
  input: unknown,
  scope: SettingsScope,
): { readonly document?: SettingsDocument; readonly problems: readonly string[] } {
  if (!isPlainObject(input)) return { problems: ["must be a JSON object"] };
  const problems: string[] = [];
  const { enabled, disabledRules, ...redaction } = input;
  if (scope === "project") {
    for (const key of GLOBAL_ONLY_KEYS)
      if (key in input) problems.push(`${key}: is allowed only in the global settings file`);
  }
  if (enabled !== undefined && typeof enabled !== "boolean") problems.push("enabled: must be true or false");
  let disabled: string[] = [];
  if (disabledRules !== undefined) {
    if (!Array.isArray(disabledRules)) problems.push("disabledRules: must be an array");
    else
      disabledRules.forEach((ruleId: unknown, index) => {
        if (typeof ruleId !== "string" || !SWITCHABLE_RULE_IDS.includes(ruleId))
          problems.push(`disabledRules[${index}]: is not a built-in rule id`);
      });
    if (Array.isArray(disabledRules)) disabled = [...new Set(disabledRules.filter((id) => typeof id === "string"))];
  }
  const { config, issues } = normalizeRedactionConfig(redaction);
  problems.push(...issues.map(formatIssue));
  if (problems.length) return { problems };
  return {
    document: Object.freeze({ enabled: enabled !== false, disabledRules: Object.freeze(disabled), config }),
    problems: [],
  };
}

/** Read one settings file. Diagnostics never expose JSON parser messages or configured values. */
export function readSettingsFileEffect(path: string, scope: SettingsScope): Effect.Effect<SettingsFileState> {
  return settingsIO(() => readFile(path, "utf8")).pipe(
    Effect.map((raw): SettingsFileState => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { state: "invalid", problems: ["is not valid JSON"] };
      }
      const { document, problems } = parseSettingsDocument(parsed, scope);
      return document ? { state: "valid", document } : { state: "invalid", problems };
    }),
    Effect.catch((error) =>
      Effect.succeed<SettingsFileState>(
        (error.cause as NodeJS.ErrnoException)?.code === "ENOENT"
          ? { state: "missing" }
          : { state: "invalid", problems: ["could not be read"] },
      ),
    ),
  );
}

/** Promise compatibility for existing consumers; extension workflows use the Effect operation. */
export function readSettingsFile(path: string, scope: SettingsScope): Promise<SettingsFileState> {
  return Effect.runPromise(readSettingsFileEffect(path, scope));
}

/** The non-terminal editor preserves raw JSON, including a malformed document the user can repair. */
export function readSettingsTextEffect(path: string): Effect.Effect<string> {
  return settingsIO(() => readFile(path, "utf8")).pipe(Effect.catch(() => Effect.succeed("{}\n")));
}

/** The JSON written for a document: defaults and empty lists are left out. */
export function serializeSettingsDocument(document: SettingsDocument): string {
  const output: Record<string, unknown> = {};
  if (!document.enabled) output.enabled = false;
  if (document.disabledRules.length) output.disabledRules = document.disabledRules;
  const { sensitiveFields, rules, exceptions, piiEntities } = document.config;
  if (sensitiveFields.length) output.sensitiveFields = sensitiveFields;
  if (rules.length) output.rules = rules;
  if (exceptions.length) output.exceptions = exceptions;
  if (piiEntities.length) output.piiEntities = piiEntities;
  return `${JSON.stringify(output, null, 2)}\n`;
}

/**
 * Own the entire atomic replacement and temporary-file cleanup. Native rename cannot be
 * cancelled, so interruption waits for this transaction instead of racing its finalizer.
 */
export function writeSettingsFileEffect(
  path: string,
  scope: SettingsScope,
  document: SettingsDocument,
): Effect.Effect<void, SettingsError> {
  return Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => {
        const serialized = serializeSettingsDocument(document);
        const { problems } = parseSettingsDocument(JSON.parse(serialized), scope);
        if (problems.length) throw new Error(problems.join("; "));
        return serialized;
      },
      catch: (cause) => new SettingsError({ message: cause instanceof Error ? cause.message : String(cause), cause }),
    });
    yield* settingsIO(() => mkdir(dirname(path), { recursive: true, mode: 0o700 }));
    yield* Effect.acquireUseRelease(
      Effect.sync(() => `${path}.${randomUUID()}.tmp`),
      (temporary) =>
        Effect.gen(function* () {
          yield* settingsIO(() => writeFile(temporary, text, { mode: 0o600 }));
          yield* settingsIO(() => rename(temporary, path));
        }),
      (temporary) => settingsIO(() => rm(temporary, { force: true })),
    );
  }).pipe(Effect.uninterruptible);
}

export function writeSettingsFile(path: string, scope: SettingsScope, document: SettingsDocument): Promise<void> {
  return Effect.runPromise(writeSettingsFileEffect(path, scope, document));
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

/** Load valid layers in order; invalid input falls back to the existing built-in policy. */
export function loadSettingsEffect(options: SettingsLocation): Effect.Effect<LoadedSettings> {
  return Effect.gen(function* () {
    const problems: string[] = [];
    const sources: string[] = [];
    const layers: RedactionConfig[] = [];
    const paths: [string, SettingsScope][] = [[globalSettingsPath(options.agentDir), "global"]];
    const projectPath = projectSettingsPath(options.cwd);
    if (options.isProjectTrusted) paths.push([projectPath, "project"]);
    else if (yield* isFile(projectPath)) problems.push(`${projectPath}: ignored because the project is not trusted`);

    let isEnabledByDefault = true;
    let disabledRules: readonly string[] = [];
    for (const [path, scope] of paths) {
      const file = yield* readSettingsFileEffect(path, scope);
      if (file.state === "invalid") problems.push(...file.problems.map((problem) => `${path}: ${problem}`));
      if (file.state !== "valid") continue;
      layers.push(file.document.config);
      sources.push(path);
      if (scope === "global") {
        isEnabledByDefault = file.document.enabled;
        disabledRules = file.document.disabledRules;
      }
    }
    return yield* Effect.try({
      try: (): LoadedSettings => ({
        redactor: createRedactor(mergeRedactionConfigs(layers)),
        disabledRules,
        isEnabledByDefault,
        sources,
        problems,
      }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          const issues =
            error instanceof RedactionConfigError ? error.issues.map(formatIssue) : ["could not be applied"];
          problems.push(...issues.map((issue) => `merged settings: ${issue}; using built-in rules`));
          return { redactor: createRedactor(), disabledRules: [], isEnabledByDefault, sources: [], problems };
        }),
      ),
    );
  });
}

export function loadSettings(options: SettingsLocation): Promise<LoadedSettings> {
  return Effect.runPromise(loadSettingsEffect(options));
}

export function customTargetsEffect(options: SettingsLocation): Effect.Effect<readonly CustomTarget[]> {
  return Effect.gen(function* () {
    const globalPath = globalSettingsPath(options.agentDir);
    const projectPath = projectSettingsPath(options.cwd);
    const globalFile = yield* readSettingsFileEffect(globalPath, "global");
    const projectFile = options.isProjectTrusted
      ? yield* readSettingsFileEffect(projectPath, "project")
      : { state: "missing" as const };
    return [
      { scope: "global", path: globalPath, file: globalFile },
      {
        scope: "project",
        path: projectPath,
        file: projectFile,
        ...(options.isProjectTrusted
          ? {}
          : { unavailableReason: "Trust this project in Pi (/trust) to edit its settings here." }),
      },
    ];
  });
}

export function setGlobalEnabledEffect(agentDir: string, isOn: boolean): Effect.Effect<void, SettingsError> {
  return Effect.gen(function* () {
    const path = globalSettingsPath(agentDir);
    const file = yield* readSettingsFileEffect(path, "global");
    if (file.state === "invalid")
      return yield* Effect.fail(
        new SettingsError({
          message: `${path} cannot be changed: ${file.problems.join("; ")}. Fix or delete it first.`,
        }),
      );
    const document = file.state === "valid" ? file.document : EMPTY_SETTINGS_DOCUMENT;
    yield* writeSettingsFileEffect(path, "global", { ...document, enabled: isOn });
  });
}

export function saveSettingsEffect(
  options: SettingsLocation,
  scope: SettingsScope,
  document: SettingsDocument,
): Effect.Effect<void, SettingsError> {
  return Effect.suspend(() => {
    if (scope === "project" && !options.isProjectTrusted)
      return Effect.fail(new SettingsError({ message: "Project settings apply only in a trusted project." }));
    const path = scope === "global" ? globalSettingsPath(options.agentDir) : projectSettingsPath(options.cwd);
    return writeSettingsFileEffect(path, scope, document);
  });
}
