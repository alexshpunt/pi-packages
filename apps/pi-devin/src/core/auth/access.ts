import { Effect } from "effect";
import type { DevinError } from "../errors.ts";
import type { JsonObject } from "../types.ts";
import { failWith } from "../validation.ts";

export function assertCanInfer(status: JsonObject): Effect.Effect<void, DevinError> {
  if (status.canUseCli !== true) return failWith("Could not confirm that this account may use the CLI.");
  if (status.dailyQuotaRemainingPercent === 0 || status.weeklyQuotaRemainingPercent === 0) return failWith("The reported quota is 0, so no inference is run.");
  return Effect.void;
}
