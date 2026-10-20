import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ModelRegistry = ExtensionContext["modelRegistry"];
type Model = NonNullable<ReturnType<ModelRegistry["find"]>>;
type ReviewReasoning = NonNullable<
    Parameters<ModelRegistry["streamSimple"]>[2]
>["reasoning"];

// Codex's preferred approval review model (codex-rs/model-provider/src/provider.rs).
// Pi's catalogs omit it, but both OpenAI backends accept it with ChatGPT sign-in.
// It is built here so only the review model picker lists it, not Pi's /model.
const AUTO_REVIEW_MODEL_ID = "codex-auto-review";
// Same-provider model whose API, endpoint, and limits the review model reuses.
const METADATA_SOURCE_MODEL_ID = "gpt-5.6-luna";
const autoReviewModelNames = new Map([
    ["openai", "Codex Auto Review (openai free)"],
    ["openai-codex", "Codex Auto Review (openai-codex)"],
]);

function autoReviewModel(source: Model): Model | undefined {
    const name = autoReviewModelNames.get(source.provider);
    return name ? { ...source, id: AUTO_REVIEW_MODEL_ID, name } : undefined;
}

/** Review-only models for providers whose metadata source model is available. */
export function reviewOnlyModels(available: readonly Model[]): Model[] {
    return available.flatMap((model) => {
        if (model.id !== METADATA_SOURCE_MODEL_ID) return [];
        const reviewModel = autoReviewModel(model);
        return reviewModel ? [reviewModel] : [];
    });
}

/** Resolves a registered model first, then a review-only model. */
export function findReviewModel(
    registry: Pick<ModelRegistry, "find">,
    provider: string,
    id: string,
): Model | undefined {
    const registered = registry.find(provider, id);
    if (registered || id !== AUTO_REVIEW_MODEL_ID) return registered;
    const source = registry.find(provider, METADATA_SOURCE_MODEL_ID);
    return source && autoReviewModel(source);
}

/**
 * Codex's select_review_model() (codex-rs/ext/guardian-reviewer/src/model.rs):
 * low when the reviewer supports it. Otherwise the current model keeps the
 * session's level; a separate reviewer has no Pi default, so it omits one.
 */
export function reviewReasoning(
    model: Model,
    sessionThinkingLevel: ExtensionContext["thinkingLevel"],
): ReviewReasoning {
    if (getSupportedThinkingLevels(model).includes("low")) return "low";
    return sessionThinkingLevel === "off" ? undefined : sessionThinkingLevel;
}
