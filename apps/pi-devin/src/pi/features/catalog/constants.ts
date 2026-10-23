import type { DevinAPI } from "./types.ts";

export const DEVIN_API: DevinAPI = "devin-connect";
export const CATALOG_VERSION = 1;
/** Default sidekick when nothing is saved or the saved one is gone. The default lead is the group this UID belongs to. */
export const FUSION_SIDEKICK_UID = "swe-2-medium";
/** The single Fusion entry shown in `/model`. Lead and sidekick follow the global `/devin-fusion` choice. */
export const FUSION_MODEL_ID = "fusion";

export function isFusionModelID(id: string): boolean { return id === FUSION_MODEL_ID; }
