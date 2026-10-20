import type {
    BeforeProviderRequestEvent,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    type FastConfig,
    isRecord,
    type ModelServiceTiers,
    type ServiceTier,
} from "./config.js";

type FastContext = Pick<ExtensionContext, "model" | "modelRegistry">;

export interface FastState {
    desiredTier: ServiceTier;
    modelServiceTiers: ModelServiceTiers;
    active: boolean;
    hasExplicitStandard: boolean;
}

export interface PayloadInjection {
    at: string;
    model: string;
    tier: "priority" | "default" | "ultrafast";
}

/** Tracks user intent separately from whether the current model can apply it. */
export class FastController {
    private state: FastState = {
        desiredTier: "standard",
        modelServiceTiers: {},
        active: false,
        hasExplicitStandard: false,
    };
    private lastInjection: PayloadInjection | undefined;
    private currentTier: ServiceTier = "standard";

    constructor(private readonly serviceTier = "priority" as const) {}

    get desiredTier(): ServiceTier {
        return this.state.desiredTier;
    }

    get active(): boolean {
        return this.state.active;
    }

    get lastPayloadInjection(): PayloadInjection | undefined {
        return this.lastInjection ? { ...this.lastInjection } : undefined;
    }

    getModelTier(model: string): ServiceTier | undefined {
        return this.state.modelServiceTiers[model] ?? undefined;
    }

    getEffectiveTier(ctx: FastContext): ServiceTier {
        return (
            (ctx.model &&
                this.getModelTier(`${ctx.model.provider}/${ctx.model.id}`)) ??
            this.desiredTier
        );
    }

    snapshot(): FastState {
        return { ...this.state };
    }

    restore(state: FastState): void {
        this.state = { ...state };
    }

    initializeForSession(
        ctx: FastContext,
        cfg: FastConfig,
        forceFast: boolean,
    ): void {
        this.state = {
            desiredTier: forceFast ? "fast" : cfg.serviceTier,
            modelServiceTiers: { ...cfg.modelServiceTiers },
            active: false,
            hasExplicitStandard: !forceFast && cfg.hasExplicitStandard,
        };
        this.lastInjection = undefined;
        this.currentTier = "standard";
        this.applyDesiredState(ctx, cfg);
    }

    supportsFast(ctx: FastContext, cfg: FastConfig): boolean {
        return (
            !!ctx.model &&
            cfg.supportedModels.includes(
                `${ctx.model.provider}/${ctx.model.id}`,
            )
        );
    }

    supportsUltrafast(ctx: FastContext): boolean {
        const model = ctx.model;
        if (
            !model ||
            (model.id !== "gpt-6-astra" && model.id !== "gpt-6.1-sol") ||
            !ctx.modelRegistry.hasConfiguredAuth(model)
        )
            return false;
        try {
            const url = new URL(model.baseUrl);
            if (
                url.protocol !== "https:" ||
                (url.port !== "" && url.port !== "443") ||
                url.username ||
                url.password ||
                url.search ||
                url.hash
            )
                return false;
            const isUsingOAuth = ctx.modelRegistry.isUsingOAuth(model);
            if (
                model.provider === "openai-codex" &&
                model.api === "openai-codex-responses"
            )
                return (
                    isUsingOAuth &&
                    url.hostname === "chatgpt.com" &&
                    /^\/backend-api(?:\/codex(?:\/responses)?)?\/?$/.test(
                        url.pathname,
                    )
                );
            return (
                model.provider === "openai" &&
                model.api === "openai-responses" &&
                (url.hostname === "api.openai.com" ||
                    url.hostname === "us.api.openai.com" ||
                    (model.id === "gpt-6.1-sol" &&
                        url.hostname === "eu.api.openai.com")) &&
                /^\/v1\/?$/.test(url.pathname)
            );
        } catch {
            return false;
        }
    }

    applyDesiredState(ctx: FastContext, cfg: FastConfig): boolean {
        const previous = this.state.active;
        const previousTier = this.currentTier;
        this.currentTier = this.getEffectiveTier(ctx);
        this.state.active =
            this.currentTier === "fast"
                ? this.supportsFast(ctx, cfg)
                : this.currentTier === "ultrafast"
                  ? this.supportsUltrafast(ctx)
                  : false;
        return (
            previous !== this.state.active || previousTier !== this.currentTier
        );
    }

    setDesired(tier: ServiceTier, ctx: FastContext, cfg: FastConfig): void {
        this.state.desiredTier = tier;
        this.state.hasExplicitStandard = tier === "standard";
        this.applyDesiredState(ctx, cfg);
    }

    setActive(isActive: boolean, ctx: FastContext, cfg: FastConfig): void {
        this.setDesired(isActive ? "fast" : "standard", ctx, cfg);
    }

    setModelTier(
        model: string,
        tier: ServiceTier | null,
        ctx: FastContext,
        cfg: FastConfig,
    ): void {
        this.state.modelServiceTiers = {
            ...this.state.modelServiceTiers,
            [model]: tier,
        };
        this.applyDesiredState(ctx, cfg);
    }

    statusSegment(ctx: FastContext, cfg: FastConfig): string | undefined {
        this.applyDesiredState(ctx, cfg);
        const hasModelStandard =
            ctx.model &&
            this.getModelTier(`${ctx.model.provider}/${ctx.model.id}`) ===
                "standard";
        return (this.active || hasModelStandard) && ctx.model
            ? `${ctx.model.id} ${this.currentTier}`
            : undefined;
    }

    persistedState(): {
        serviceTier: ServiceTier;
        desiredActive: boolean;
        active: boolean;
    } {
        return {
            serviceTier: this.desiredTier,
            desiredActive: this.desiredTier !== "standard",
            active: this.active,
        };
    }

    injectProviderPayload(
        event: BeforeProviderRequestEvent,
        ctx: FastContext,
        cfg: FastConfig,
    ): Record<string, unknown> | undefined {
        const payload = event.payload;
        if (!isRecord(payload) || !ctx.model || payload.model !== ctx.model.id)
            return undefined;
        this.applyDesiredState(ctx, cfg);
        const desiredTier = this.getEffectiveTier(ctx);
        let tier: PayloadInjection["tier"];
        if (desiredTier === "standard") {
            const hasModelStandard =
                this.getModelTier(`${ctx.model.provider}/${ctx.model.id}`) ===
                "standard";
            if (
                (!this.state.hasExplicitStandard && !hasModelStandard) ||
                (!this.supportsFast(ctx, cfg) && !this.supportsUltrafast(ctx))
            )
                return undefined;
            tier = "default";
        } else {
            if (!this.active) return undefined;
            tier = desiredTier === "ultrafast" ? "ultrafast" : this.serviceTier;
        }
        this.lastInjection = {
            at: new Date().toISOString(),
            model: `${ctx.model.provider}/${ctx.model.id}`,
            tier,
        };
        return { ...payload, service_tier: tier };
    }
}
