import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ServiceTier = "standard" | "fast" | "ultrafast";
export type ModelServiceTiers = Readonly<Record<string, ServiceTier | null>>;

export interface FastConfig {
    serviceTier: ServiceTier;
    modelServiceTiers: ModelServiceTiers;
    hasExplicitStandard: boolean;
    persistState: boolean;
    notifyOnModelSwitch: boolean;
    supportedModels: readonly string[];
}

export const DEFAULT_SUPPORTED_MODELS: readonly string[] = Object.freeze([
    "openai/gpt-5.4",
    "openai/gpt-5.5",
    "openai/gpt-6-astra",
    "openai/gpt-6.1-sol",
    "openai/gpt-6-sol",
    "openai/gpt-6-luna",
    "openai-codex/gpt-6-astra",
    "openai-codex/gpt-6.1-sol",
    "openai-codex/gpt-6-sol",
    "openai-codex/gpt-6-luna",
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-terra",
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.5",
]);

export const DEFAULT_CONFIG: Readonly<FastConfig> = Object.freeze({
    serviceTier: "standard",
    modelServiceTiers: Object.freeze({}),
    hasExplicitStandard: false,
    persistState: true,
    notifyOnModelSwitch: true,
    supportedModels: DEFAULT_SUPPORTED_MODELS,
});

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isServiceTier(value: unknown): value is ServiceTier {
    return value === "standard" || value === "fast" || value === "ultrafast";
}

function validateLayer(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) throw new Error("Settings must be a JSON object.");
    if (value.serviceTier !== undefined && !isServiceTier(value.serviceTier))
        throw new Error("serviceTier must be standard, fast, or ultrafast.");
    if (
        value.modelServiceTiers !== undefined &&
        (!isRecord(value.modelServiceTiers) ||
            !Object.entries(value.modelServiceTiers).every(
                ([model, tier]) =>
                    /^\S+\/\S+$/.test(model) &&
                    (tier === null || isServiceTier(tier)),
            ))
    )
        throw new Error(
            "modelServiceTiers must map provider/id strings to standard, fast, ultrafast, or null (use global speed).",
        );
    for (const key of [
        "desiredActive",
        "active",
        "persistState",
        "notifyOnModelSwitch",
    ]) {
        if (value[key] !== undefined && typeof value[key] !== "boolean")
            throw new Error(`${key} must be true or false.`);
    }
    if (value.fast !== undefined) {
        if (!isRecord(value.fast)) throw new Error("fast must be an object.");
        if (
            value.fast.enabled !== undefined &&
            typeof value.fast.enabled !== "boolean"
        )
            throw new Error("fast.enabled must be true or false.");
    }
    if (
        value.supportedModels !== undefined &&
        (!Array.isArray(value.supportedModels) ||
            !value.supportedModels.every(
                (model) =>
                    typeof model === "string" && /^\S+\/\S+$/.test(model),
            ))
    )
        throw new Error(
            "supportedModels must be an array of provider/id strings.",
        );
    return value;
}

/** Resolve each layer before merging so project legacy flags override global serviceTier. */
export function resolveConfig(layers: readonly unknown[]): FastConfig {
    const config: FastConfig = { ...DEFAULT_CONFIG };
    for (const input of layers) {
        const layer = validateLayer(input);
        const enabled =
            layer.desiredActive ??
            layer.active ??
            (isRecord(layer.fast) ? layer.fast.enabled : undefined);
        const tier = isServiceTier(layer.serviceTier)
            ? layer.serviceTier
            : typeof enabled === "boolean"
              ? enabled
                  ? "fast"
                  : "standard"
              : undefined;
        if (tier !== undefined) {
            config.serviceTier = tier;
            config.hasExplicitStandard = tier === "standard";
        }
        if (isRecord(layer.modelServiceTiers))
            config.modelServiceTiers = {
                ...config.modelServiceTiers,
                ...(layer.modelServiceTiers as ModelServiceTiers),
            };
        if (typeof layer.persistState === "boolean")
            config.persistState = layer.persistState;
        if (typeof layer.notifyOnModelSwitch === "boolean")
            config.notifyOnModelSwitch = layer.notifyOnModelSwitch;
        if (Array.isArray(layer.supportedModels))
            config.supportedModels = [...layer.supportedModels];
    }
    return config;
}

async function readSettings(
    path: string,
): Promise<Record<string, unknown> | undefined> {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
        throw new Error(
            `${path}: ${error instanceof Error ? error.message : String(error)}`,
            {
                cause: error,
            },
        );
    }
    try {
        return validateLayer(JSON.parse(raw));
    } catch (error) {
        throw new Error(
            `${path}: ${error instanceof Error ? error.message : String(error)}`,
            {
                cause: error,
            },
        );
    }
}

/** Preserve unknown settings and write to the existing project layer, otherwise global. */
export class FastSettingsStore {
    private path: string;

    constructor(
        readonly globalPath: string,
        readonly projectPath: string,
    ) {
        this.path = globalPath;
    }

    get settingsPath(): string {
        return this.path;
    }

    async load(): Promise<FastConfig> {
        const global = await readSettings(this.globalPath);
        const project = await readSettings(this.projectPath);
        this.path = project === undefined ? this.globalPath : this.projectPath;
        return resolveConfig([global ?? {}, project ?? {}]);
    }

    async persist(state: {
        serviceTier: ServiceTier;
        desiredActive: boolean;
        active: boolean;
    }): Promise<void> {
        const current = (await readSettings(this.path)) ?? {};
        await this.write({ ...current, ...state });
    }

    async persistModelTier(
        model: string,
        tier: ServiceTier | null,
    ): Promise<void> {
        const current = (await readSettings(this.path)) ?? {};
        const modelServiceTiers = {
            ...(isRecord(current.modelServiceTiers)
                ? current.modelServiceTiers
                : {}),
        };
        if (tier === null && this.path === this.globalPath)
            delete modelServiceTiers[model];
        else modelServiceTiers[model] = tier;
        const next = { ...current, modelServiceTiers };
        validateLayer(next);
        await this.write(next);
    }

    private async write(next: Record<string, unknown>): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
                flag: "wx",
                mode: 0o600,
            });
            await rename(temporary, this.path);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}
