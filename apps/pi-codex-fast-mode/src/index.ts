import { join } from "node:path";
import {
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
    DEFAULT_CONFIG,
    type FastConfig,
    FastSettingsStore,
    isServiceTier,
    type ServiceTier,
} from "./config.js";
import { FastController } from "./fast-controller.js";
import { type ModelSpeedSetting, showFastSettings } from "./fast-ui.js";

const SERVICE_TIER = "priority";
const COMMAND_NAME = "codex-fast";
const STATUS_KEY = "codex-fast-mode";
const SETTINGS_DIRECTORY = "codex-fast-mode";
const MODEL_FAMILY_ORDER = ["astra", "sol", "luna"];
const COMMAND_USAGE =
    "Usage: /codex-fast [status|on|off], /codex-fast speed <standard|fast|ultrafast>, /codex-fast <fast|ultrafast> <on|off>, or /codex-fast model <provider/id> <standard|fast|ultrafast|inherit>";

export function defaultSettingsPath(): string {
    return join(getAgentDir(), SETTINGS_DIRECTORY, "settings.json");
}

function report(
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error" = "info",
): void {
    if (ctx.hasUI) ctx.ui.notify(message, type);
    else process.stderr.write(`${message}\n`);
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function completions(values: readonly string[], prefix: string) {
    const matches = values
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value }));
    return matches.length ? matches : null;
}

function compareModelSettings(
    a: ModelSpeedSetting,
    b: ModelSpeedSetting,
): number {
    const pattern = /^gpt-(\d+(?:\.\d+)*)-(astra|sol|luna)(?:-|$)/;
    const aMatch = a.model.slice(a.model.indexOf("/") + 1).match(pattern);
    const bMatch = b.model.slice(b.model.indexOf("/") + 1).match(pattern);
    const aRank = aMatch
        ? MODEL_FAMILY_ORDER.indexOf(aMatch[2])
        : MODEL_FAMILY_ORDER.length;
    const bRank = bMatch
        ? MODEL_FAMILY_ORDER.indexOf(bMatch[2])
        : MODEL_FAMILY_ORDER.length;
    if (aRank !== bRank) return aRank - bRank;
    if (aMatch && bMatch) {
        const aVersion = aMatch[1].split(".").map(Number);
        const bVersion = bMatch[1].split(".").map(Number);
        for (let i = 0; i < Math.max(aVersion.length, bVersion.length); i++) {
            const difference = (bVersion[i] ?? 0) - (aVersion[i] ?? 0);
            if (difference) return difference;
        }
    }
    return a.model.localeCompare(b.model);
}

export default function codexFastModeExtension(pi: ExtensionAPI): void {
    const fastController = new FastController(SERVICE_TIER);
    let cfg: FastConfig = { ...DEFAULT_CONFIG };
    let store: FastSettingsStore | undefined;

    const updateStatus = (ctx: ExtensionContext) => {
        ctx.ui.setStatus(STATUS_KEY, fastController.statusSegment(ctx, cfg));
    };
    const describeState = (ctx: ExtensionContext) => {
        const tier = fastController.getEffectiveTier(ctx);
        const model = ctx.model
            ? `${ctx.model.provider}/${ctx.model.id}`
            : "No model selected";
        const application =
            tier === "standard"
                ? "Standard requests"
                : fastController.active
                  ? "Request enabled"
                  : "Unsupported by this model; preference retained";
        const source =
            ctx.model &&
            fastController.getModelTier(
                `${ctx.model.provider}/${ctx.model.id}`,
            ) !== undefined
                ? "model override"
                : "global speed";
        return `OpenAI requested service tier: ${tier} · ${application} · ${model} · ${source}`;
    };
    const showStatus = (ctx: ExtensionContext) => {
        fastController.applyDesiredState(ctx, cfg);
        const last = fastController.lastPayloadInjection;
        report(
            ctx,
            [
                describeState(ctx),
                `Global speed: ${fastController.desiredTier}`,
                `Settings: ${store?.settingsPath ?? defaultSettingsPath()}`,
                cfg.persistState
                    ? "Mode changes are saved to the settings file."
                    : "Mode changes apply only to this session.",
                last
                    ? `Last payload injection: ${last.at} · ${last.model} · ${last.tier} (request only; server processing and billing not verified)`
                    : "No service tier has been injected into a request during this session.",
            ].join("\n"),
        );
    };
    const persist = async () => {
        if (cfg.persistState && store)
            await store.persist(fastController.persistedState());
    };
    const changeTier = async (
        tier: ServiceTier,
        ctx: ExtensionCommandContext,
    ): Promise<void> => {
        await ctx.waitForIdle();
        const previous = fastController.snapshot();
        if (tier === "ultrafast") fastController.setDesired(tier, ctx, cfg);
        else fastController.setActive(tier === "fast", ctx, cfg);
        try {
            await persist();
        } catch (error) {
            fastController.restore(previous);
            updateStatus(ctx);
            throw error;
        }
        updateStatus(ctx);
        report(
            ctx,
            `Global speed: ${tier}\n${describeState(ctx)}${cfg.persistState ? "" : " · This session only"}`,
        );
    };
    const changeModelTier = async (
        modelKey: string,
        tier: ServiceTier | null,
        ctx: ExtensionCommandContext,
    ): Promise<void> => {
        await ctx.waitForIdle();
        if (!/^\S+\/\S+$/.test(modelKey))
            throw new Error("Expected a provider/model ID.");
        if (tier !== null) {
            const separator = modelKey.indexOf("/");
            const model = ctx.modelRegistry.find(
                modelKey.slice(0, separator),
                modelKey.slice(separator + 1),
            );
            if (!model) throw new Error(`Model not found: ${modelKey}`);
            const modelContext = { model, modelRegistry: ctx.modelRegistry };
            const canRequestFast = fastController.supportsFast(
                modelContext,
                cfg,
            );
            const canRequestUltrafast =
                fastController.supportsUltrafast(modelContext);
            if (
                (!canRequestFast && !canRequestUltrafast) ||
                (tier === "fast" && !canRequestFast) ||
                (tier === "ultrafast" && !canRequestUltrafast)
            )
                throw new Error(
                    `Speed ${tier} is unavailable for ${modelKey} with the current provider configuration.`,
                );
        }
        const previous = fastController.snapshot();
        fastController.setModelTier(modelKey, tier, ctx, cfg);
        try {
            if (cfg.persistState && store)
                await store.persistModelTier(modelKey, tier);
        } catch (error) {
            fastController.restore(previous);
            updateStatus(ctx);
            throw error;
        }
        updateStatus(ctx);
        report(
            ctx,
            `Model speed: ${modelKey} · ${tier ?? "use global"}${cfg.persistState ? "" : " · This session only"}\n${describeState(ctx)}`,
        );
    };
    const runCommand = async (
        ctx: ExtensionCommandContext,
        action: () => Promise<void>,
    ) => {
        try {
            await action();
        } catch (error) {
            report(
                ctx,
                `Could not change Fast mode: ${describeError(error)}`,
                "error",
            );
        }
    };
    const changeMode = async (
        mode: "fast" | "ultrafast",
        isEnabled: boolean,
        ctx: ExtensionCommandContext,
    ) => {
        if (!isEnabled && fastController.desiredTier !== mode) {
            report(ctx, describeState(ctx));
            return;
        }
        await changeTier(isEnabled ? mode : "standard", ctx);
    };
    const openFastSettings = async (ctx: ExtensionCommandContext) => {
        if (!ctx.hasUI) {
            report(ctx, `${describeState(ctx)}\n${COMMAND_USAGE}`);
            return;
        }
        await ctx.waitForIdle();
        const availableModels = new Map(
            ctx.modelRegistry
                .getAvailable()
                .map((model) => [`${model.provider}/${model.id}`, model]),
        );
        const scopedModels = ctx.scopedModels ?? [];
        const models = scopedModels.length
            ? new Map(
                  scopedModels.flatMap(({ model }) => {
                      const key = `${model.provider}/${model.id}`;
                      const registered = availableModels.get(key);
                      return registered ? [[key, registered] as const] : [];
                  }),
              )
            : availableModels;
        const currentModel = ctx.model
            ? `${ctx.model.provider}/${ctx.model.id}`
            : undefined;
        const modelSettings: ModelSpeedSetting[] = [];
        for (const [key, model] of models) {
            const modelContext = { model, modelRegistry: ctx.modelRegistry };
            const availableTiers: ServiceTier[] = ["standard"];
            if (fastController.supportsFast(modelContext, cfg))
                availableTiers.push("fast");
            if (fastController.supportsUltrafast(modelContext))
                availableTiers.push("ultrafast");
            if (availableTiers.length > 1)
                modelSettings.push({
                    model: key,
                    isCurrentModel: key === currentModel,
                    availableTiers,
                });
        }
        modelSettings.sort(compareModelSettings);
        await showFastSettings(ctx, {
            models: modelSettings,
            getGlobalTier: () => fastController.desiredTier,
            getModelTier: (model) => fastController.getModelTier(model),
            setGlobalTier: (tier) => changeTier(tier, ctx),
            setModelTier: (model, tier) => changeModelTier(model, tier, ctx),
        });
    };

    pi.registerFlag("fast", {
        description:
            "Start with global Fast speed; model-specific speeds take precedence.",
        type: "boolean",
        default: false,
    });
    pi.registerCommand(COMMAND_NAME, {
        description:
            "Configure model and global Standard, Fast, and Ultrafast speeds.",
        getArgumentCompletions: (prefix) =>
            completions(
                [
                    "status",
                    "on",
                    "off",
                    "speed standard",
                    "speed fast",
                    "speed ultrafast",
                    "model ",
                    "fast on",
                    "fast off",
                    "ultrafast on",
                    "ultrafast off",
                ],
                prefix,
            ),
        handler: (args, ctx) =>
            runCommand(ctx, async () => {
                const value = args.trim();
                if (!value) return openFastSettings(ctx);
                if (value === "status") return showStatus(ctx);
                if (value === "on" || value === "off") {
                    await changeTier(value === "on" ? "fast" : "standard", ctx);
                    return;
                }
                const [mode, state, extra, trailing] = value.split(/\s+/);
                if (!extra && mode === "speed" && isServiceTier(state)) {
                    await changeTier(state, ctx);
                    return;
                }
                if (
                    !trailing &&
                    mode === "model" &&
                    state &&
                    (isServiceTier(extra) || extra === "inherit")
                ) {
                    await changeModelTier(
                        state,
                        extra === "inherit" ? null : extra,
                        ctx,
                    );
                    return;
                }
                if (
                    !extra &&
                    (mode === "fast" || mode === "ultrafast") &&
                    (state === "on" || state === "off")
                ) {
                    await changeMode(mode, state === "on", ctx);
                    return;
                }
                report(ctx, COMMAND_USAGE, "error");
            }),
    });

    pi.on("session_start", async (_event, ctx) => {
        store = new FastSettingsStore(
            defaultSettingsPath(),
            join(ctx.cwd, ".pi", SETTINGS_DIRECTORY, "settings.json"),
        );
        try {
            cfg = await store.load();
        } catch (error) {
            cfg = { ...DEFAULT_CONFIG, persistState: false };
            report(
                ctx,
                `Could not load Fast settings: ${describeError(error)}. Starting with defaults; changes apply only to this session.`,
                "error",
            );
        }
        fastController.initializeForSession(
            ctx,
            cfg,
            pi.getFlag("fast") === true,
        );
        updateStatus(ctx);
    });
    pi.on("model_select", async (_event, ctx) => {
        const hasChanged = fastController.applyDesiredState(ctx, cfg);
        updateStatus(ctx);
        if (hasChanged && cfg.notifyOnModelSwitch)
            report(ctx, describeState(ctx));
    });
    pi.on("before_provider_request", (event, ctx) =>
        fastController.injectProviderPayload(event, ctx, cfg),
    );
    pi.on("session_shutdown", (_event, ctx) => {
        ctx.ui.setStatus(STATUS_KEY, undefined);
    });
}
