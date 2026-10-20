import type { JsonObject, ModelInfo } from "../types.ts";

/** When the server provides a separate allowlist, it is applied together with the catalog's disabled flags. */
export function applyTeamModelPolicy(models: ModelInfo[], team: JsonObject): void {
  const allowed = Array.isArray(team.allowedModelUids) ? team.allowedModelUids.filter((id): id is string => typeof id === "string") : [];
  if (allowed.length) for (const model of models) model.isDisabled ||= !allowed.includes(model.id);
}
