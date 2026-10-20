import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { assembleModels } from "./metadata.ts";

/** Keep dynamic context/modality facts, but reapply current local price, limit, compat and off policies. */
export function restoreModelPolicies(
  models: readonly ProviderModelConfig[],
  nativeThinkingIds: readonly string[] = [],
): ProviderModelConfig[] {
  const nativeIds = new Set(nativeThinkingIds);
  return models.flatMap((model) => {
    if (!model || typeof model.id !== "string" || !model.id || !("reasoning" in model)) return [];
    const capabilities = ["tools"];
    if (model.reasoning) capabilities.push("thinking");
    if (Array.isArray(model.input) && model.input.includes("image")) capabilities.push("vision");
    const values =
      nativeIds.has(model.id) && model.thinkingLevelMap
        ? [
            ...new Set(
              Object.values(model.thinkingLevelMap)
                .filter((value) => typeof value === "string")
                .map((value) => (value === "none" ? false : value)),
            ),
          ]
        : undefined;
    const [current] = assembleModels({
      [model.id]: {
        capabilities,
        model_info: { "snapshot.context_length": model.contextWindow },
        ...(values?.length ? { thinking: { values } } : {}),
      },
    });
    return current ? [{ ...model, ...current, name: model.name }] : [];
  });
}
