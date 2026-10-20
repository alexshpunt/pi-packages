import type { JsonObject } from "../types.ts";

export function assertCanInfer(status: JsonObject): void {
  if (status.canUseCli !== true) throw new Error("Could not confirm that this account may use the CLI.");
  if (status.dailyQuotaRemainingPercent === 0 || status.weeklyQuotaRemainingPercent === 0) throw new Error("The reported quota is 0, so no inference is run.");
}
