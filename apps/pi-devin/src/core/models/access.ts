import { Predicate } from "effect";
import type { JsonObject, ModelInfo } from "../types.ts";

/** When the server provides a separate allowlist, it is applied together with the catalog's disabled flags. */
export function applyTeamModelPolicy(models: readonly ModelInfo[], team: JsonObject): ModelInfo[] {
  const allowed = Array.isArray(team.allowedModelUids) ? team.allowedModelUids.filter(Predicate.isString) : [];
  return allowed.length ? models.map((model) => ({ ...model, isDisabled: model.isDisabled || !allowed.includes(model.id) })) : [...models];
}
