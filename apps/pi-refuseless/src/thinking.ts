import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REFUSELESS_PROVIDER_ID, type RefuselessModel } from "./models.ts";

/**
 * The thinking level to use after Pi switched the session to `model` and set `level`, or undefined to keep it.
 *
 * Pi carries the session's thinking level over to the next model and, when the model does not offer it, moves
 * it to the next offered level. A session without a model, or on a model without thinking levels, is at "off"
 * that nobody chose; Pi would carry that "off" over too. A Refuseless model then starts at its
 * `reasoning_default` instead. A level that a Pi setting chose instead of the carried "off" (a per-model or
 * default thinking level, a `--models` level) is not where Pi takes "off", and is kept.
 */
export function levelAfterSwitch(
  model: Model<any>,
  previousModel: Model<any> | undefined,
  level: ModelThinkingLevel,
): ModelThinkingLevel | undefined {
  const fallback = model.provider === REFUSELESS_PROVIDER_ID ? (model as RefuselessModel).reasoningDefault : undefined;
  if (!fallback || level === fallback) return undefined;
  if (previousModel && getSupportedThinkingLevels(previousModel).some((entry) => entry !== "off")) return undefined;
  return level === clampThinkingLevel(model, "off") ? fallback : undefined;
}

/** Applies `levelAfterSwitch` when the user picks a model; a resumed session keeps its saved level. */
export function registerThinkingDefault(pi: ExtensionAPI) {
  pi.on("model_select", (event) => {
    if (event.source === "restore") return;
    const level = levelAfterSwitch(event.model, event.previousModel, pi.getThinkingLevel());
    if (level) pi.setThinkingLevel(level);
  });
}
