import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { devinSettingsPath, fileDevinSettings } from "./src/pi/devin-settings.ts";
import { registerDevinExtension } from "./src/pi/extension.ts";
import { fileFusionSettings, fusionSettingsPath } from "./src/pi/fusion-settings.ts";
import { modelCallLimit } from "./src/pi/lifecycle.ts";
import { FUSION_CHILD_ENV } from "./src/pi/sidekick.ts";
import { accountUsagePath, fileAccountUsageStore } from "./src/pi/usage-store.ts";

export default function devinExtension(pi: ExtensionAPI): void {
  const isFusionChild = process.env[FUSION_CHILD_ENV] === "1";
  registerDevinExtension(pi, {
    maxModelCalls: modelCallLimit(process.env.PI_DEVIN_MAX_MODEL_CALLS),
    isFusionChild,
    // The sidekick child records its quota too, so the lead's status shows what the sidekick used.
    accountUsage: fileAccountUsageStore(accountUsagePath(getAgentDir())),
    fusionSettings: isFusionChild ? undefined : fileFusionSettings(fusionSettingsPath(getAgentDir())),
    devinSettings: isFusionChild ? undefined : fileDevinSettings(devinSettingsPath(getAgentDir())),
  });
}
