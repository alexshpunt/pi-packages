import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Which Codex surfaces the package exposes. Both default to on. */
export interface FeatureState {
    computerUse: boolean;
    browserUse: boolean;
}

export type FeatureKey = keyof FeatureState;

const FEATURE_KEYS: readonly FeatureKey[] = ["computerUse", "browserUse"];

export const DEFAULT_FEATURE_STATE: Readonly<FeatureState> = Object.freeze({
    computerUse: true,
    browserUse: true,
});

/** Used when the settings file exists but cannot be trusted (fail closed). */
export const DISABLED_FEATURE_STATE: Readonly<FeatureState> = Object.freeze({
    computerUse: false,
    browserUse: false,
});

export class SettingsError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "SettingsError";
    }
}

function isFeatureKey(key: string): key is FeatureKey {
    return (FEATURE_KEYS as readonly string[]).includes(key);
}

/** Accepts exactly `{ computerUse: boolean, browserUse: boolean }`. */
export function validateFeatureState(value: unknown): FeatureState {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new SettingsError("settings must be a JSON object");
    const record = value as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter((key) => !isFeatureKey(key));
    if (unknownKeys.length > 0)
        throw new SettingsError(
            `unknown settings keys: ${unknownKeys.join(", ")}`,
        );
    for (const key of FEATURE_KEYS)
        if (typeof record[key] !== "boolean")
            throw new SettingsError(`"${key}" must be true or false`);
    return {
        computerUse: record.computerUse as boolean,
        browserUse: record.browserUse as boolean,
    };
}

export type SettingsSource = "defaults" | "file" | "invalid";

export interface SettingsLoadResult {
    source: SettingsSource;
    state: FeatureState;
    /** Present when `source` is `invalid`. */
    error?: string;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Persists the two feature flags as JSON. A missing file means the defaults; an unreadable or
 * invalid file is reported and treated as both features off for the session.
 */
export class FeatureSettingsStore {
    constructor(readonly path: string) {}

    async load(): Promise<SettingsLoadResult> {
        let raw: string;
        try {
            raw = await readFile(this.path, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return {
                    source: "defaults",
                    state: { ...DEFAULT_FEATURE_STATE },
                };
            return {
                source: "invalid",
                state: { ...DISABLED_FEATURE_STATE },
                error: `could not read ${this.path}: ${describeError(error)}`,
            };
        }
        try {
            return {
                source: "file",
                state: validateFeatureState(JSON.parse(raw)),
            };
        } catch (error) {
            return {
                source: "invalid",
                state: { ...DISABLED_FEATURE_STATE },
                error: `invalid settings in ${this.path}: ${describeError(error)}`,
            };
        }
    }

    /** Writes atomically (temporary file + rename) with owner-only permissions. */
    async save(state: FeatureState): Promise<void> {
        const validated = validateFeatureState(state);
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
            await writeFile(
                temporary,
                `${JSON.stringify(validated, null, 2)}\n`,
                {
                    flag: "wx",
                    mode: 0o600,
                },
            );
            await rename(temporary, this.path);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}

export function describeFeatureState(state: FeatureState): string {
    const onOff = (value: boolean) => (value ? "on" : "off");
    return `Computer Use: ${onOff(state.computerUse)} · Browser Use: ${onOff(state.browserUse)}`;
}
