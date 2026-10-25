import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Layer } from "effect";
import { NodeDeviceIdentitySource } from "../../core/services/device-identity.ts";
import { NodeHttpTransport, nodeTransport } from "../../core/services/http-transport.ts";
import { NodePlatformLayer } from "../../core/services/platform.ts";
import { accountUsagePath, devinSettingsPath, DisplaySettingsFile, fusionSettingsPath, FusionSettingsFile, UsageStoreFile } from "../adapters/storage/files.ts";
import { LoginTransport } from "../features/auth/login.ts";
import { DisplaySettings, FusionSettings, memoryDisplaySettings, memoryFusionSettings } from "../features/settings/service.ts";
import { NodeSidekickLauncher } from "../features/sidekick/launcher.ts";
import { ExtensionConfig } from "./config.ts";
import type { ExtensionEnvironment } from "./layer.ts";

/**
 * The environment Pi loads the extension with: Node's network, process and file services, and the global stores in Pi's agent directory.
 * The sidekick child keeps no Fusion or display settings, but records its quota so the lead shows what the sidekick used.
 */
export function productionEnvironment(options: { isFusionChild: boolean }): Layer.Layer<ExtensionEnvironment> {
  const agentDir = getAgentDir();
  const settings = options.isFusionChild
    ? Layer.mergeAll(Layer.sync(FusionSettings, () => memoryFusionSettings()), Layer.sync(DisplaySettings, () => memoryDisplaySettings()))
    : Layer.mergeAll(FusionSettingsFile(fusionSettingsPath(agentDir)), DisplaySettingsFile(devinSettingsPath(agentDir)));
  return Layer.mergeAll(
    Layer.succeed(ExtensionConfig, { isFusionChild: options.isFusionChild, now: Date.now, login: {}, agentDir: getAgentDir }),
    NodeHttpTransport(),
    Layer.succeed(LoginTransport, nodeTransport()),
    settings,
    UsageStoreFile(accountUsagePath(agentDir)),
    NodeSidekickLauncher,
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeDeviceIdentitySource.pipe(Layer.provide(NodePlatformLayer)), NodePlatformLayer)));
}
