import type { ThinkingLevel } from "@earendil-works/pi-ai";

export const MEMORY_REASONING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export interface ModelChoice {
    provider: string;
    id: string;
    reasoning?: ThinkingLevel;
}
export interface MemorySettings {
    useMemories: boolean;
    injectSummary: boolean;
    generateMemories: boolean;
    extractModel: ModelChoice | null;
    consolidateModel: ModelChoice | null;
    minIdleMs: number;
    consolidationCooldownMs: number;
    pollIntervalMs: number;
    maxRolloutsPerRun: number;
    maxRolloutAgeDays: number;
    maxUnusedDays: number;
    maxSources: number;
    maxInputBytes: number;
    maxOutputTokens: number;
    timeoutMs: number;
    retryDelayMs: number;
    maxAttempts: number;
    maxCallsPerDay: number;
    maxInjectionBytes: number;
}
export const DEFAULT_SETTINGS: Readonly<MemorySettings> = Object.freeze({
    useMemories: true,
    injectSummary: true,
    generateMemories: false,
    extractModel: null,
    consolidateModel: null,
    minIdleMs: 30 * 60_000,
    consolidationCooldownMs: 60 * 60_000,
    pollIntervalMs: 60_000,
    maxRolloutsPerRun: 2,
    maxRolloutAgeDays: 10,
    maxUnusedDays: 30,
    maxSources: 256,
    maxInputBytes: 256 * 1024,
    maxOutputTokens: 4096,
    timeoutMs: 120_000,
    retryDelayMs: 15 * 60_000,
    maxAttempts: 3,
    maxCallsPerDay: 24,
    maxInjectionBytes: 12 * 1024,
});
const ranges: Record<string, readonly [number, number]> = {
    minIdleMs: [60_000, 48 * 3_600_000],
    consolidationCooldownMs: [60_000, 48 * 3_600_000],
    pollIntervalMs: [1000, 3_600_000],
    maxRolloutsPerRun: [1, 32],
    maxRolloutAgeDays: [1, 90],
    maxUnusedDays: [1, 365],
    maxSources: [1, 256],
    maxInputBytes: [64 * 1024, 2 * 1024 * 1024],
    maxOutputTokens: [512, 16_384],
    timeoutMs: [1000, 600_000],
    retryDelayMs: [1000, 86_400_000],
    maxAttempts: [1, 10],
    maxCallsPerDay: [1, 1000],
    maxInjectionBytes: [1024, 16 * 1024],
};
export function parseSettings(value: unknown): MemorySettings {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Memory settings must be an object.");
    const settings = { ...DEFAULT_SETTINGS, ...value } as MemorySettings;
    for (const [key, item] of Object.entries(settings)) {
        if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error(`Unknown memory setting: ${key}`);
        if (key.endsWith("Model")) {
            if (item !== null && (!item || typeof item !== "object" ||
                Array.isArray(item) || Object.keys(item).some(k => k !== "provider" && k !== "id" && k !== "reasoning") ||
                (item.reasoning !== undefined && !MEMORY_REASONING_LEVELS.includes(item.reasoning)) ||
                typeof item.provider !== "string" || !item.provider.trim() ||
                typeof item.id !== "string" || !item.id.trim()))
                throw new Error(`Invalid model setting: ${key}`);
        } else if (ranges[key]) {
            const [min, max] = ranges[key];
            if (!Number.isSafeInteger(item) || Number(item) < min || Number(item) > max)
                throw new Error(`${key} must be an integer between ${min} and ${max}.`);
        } else if (typeof item !== "boolean") throw new Error(`${key} must be a boolean.`);
    }
    if (settings.generateMemories && (!settings.extractModel || !settings.consolidateModel))
        throw new Error("Select extraction and consolidation models before enabling generation.");
    return settings;
}
export function isSourceEligible(updatedAtMs: number, nowMs: number, settings: MemorySettings): boolean {
    const ageMs = nowMs - updatedAtMs;
    return ageMs >= settings.minIdleMs && ageMs <= settings.maxRolloutAgeDays * 86_400_000;
}
