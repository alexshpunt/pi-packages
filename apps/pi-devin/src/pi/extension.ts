import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDevinProvider, type DevinProvider } from "./provider.ts";
import { DEVIN_STATE_ENTRY } from "./lifecycle.ts";
import { registerDevinCommand, updateUsageStatus } from "./devin-command.ts";
import { memoryDevinSettings, type DevinSettings } from "./devin-settings.ts";
import { registerFusionCommand } from "./fusion-command.ts";
import { memoryFusionSettings, type FusionSettings } from "./fusion-settings.ts";
import { createSidekickTool, fusionOf, SIDEKICK_TOOL_NAME, type SidekickToolOptions } from "./sidekick.ts";

type ProviderOptions = NonNullable<Parameters<typeof createDevinProvider>[0]>;
export interface DevinExtensionOptions extends Omit<ProviderOptions, "fusion" | "listsAllExactModels" | "recommendedOnly" | "onAccountUsage"> {
  /** Store for the `/devin-fusion` choice. Kept in memory only when omitted. */
  fusionSettings?: FusionSettings;
  /** Store for the `/devin` display settings. Kept in memory only when omitted. */
  devinSettings?: DevinSettings;
  /** The child Pi started as the sidekick registers no Fusion model, tool or command, and no `/devin` or status line. */
  isFusionChild?: boolean;
  /** Overrides the sidekick session location and how the child starts. The default location is the Pi agent directory. */
  sidekick?: Partial<SidekickToolOptions>;
}

export function registerDevinExtension(pi: ExtensionAPI, options: DevinExtensionOptions = {}): DevinProvider {
  const { fusionSettings, devinSettings, isFusionChild, sidekick: sidekickOptions, ...providerOptions } = options;
  const settings = fusionSettings ?? memoryFusionSettings();
  const preferences = isFusionChild ? undefined : devinSettings ?? memoryDevinSettings();
  // Context of the current session, used to redraw the status when the quota changes outside event handlers.
  let statusContext: ExtensionContext | undefined;
  const refreshStatus = (context: ExtensionContext, pendingMessage?: unknown) => { if (preferences) updateUsageStatus(context, provider, preferences, pendingMessage); };
  // The child Pi runs on the exact UID the lead chose, so it lists every exact UID and ignores the recommended filter.
  const provider = createDevinProvider({
    ...providerOptions, fusion: isFusionChild ? false : () => settings.read(), listsAllExactModels: isFusionChild === true,
    recommendedOnly: preferences ? () => preferences.read().recommendedOnly : undefined,
    onAccountUsage: () => {
      if (!statusContext) return;
      try { refreshStatus(statusContext); } catch { /* The session was replaced or reloaded; its next session_start redraws. */ }
    },
  });
  pi.registerProvider(provider);
  if (preferences) registerDevinCommand(pi, provider, preferences);
  const sidekick = isFusionChild ? undefined
    : createSidekickTool(pi, provider, { agentDir: sidekickOptions?.agentDir ?? getAgentDir, runtime: sidekickOptions?.runtime });
  if (sidekick) {
    pi.registerTool(sidekick.definition);
    registerFusionCommand(pi, provider, settings);
  }
  // Enables the sidekick only for the Fusion model and leaves other extensions' and the user's active tools alone.
  const syncSidekick = (model: Model<any> | undefined) => {
    if (!sidekick) return;
    const active = pi.getActiveTools(), isActive = active.includes(SIDEKICK_TOOL_NAME);
    const shouldBeActive = fusionOf(provider, model) !== undefined;
    if (shouldBeActive && !isActive) pi.setActiveTools([...active, SIDEKICK_TOOL_NAME]);
    else if (!shouldBeActive && isActive) pi.setActiveTools(active.filter((name) => name !== SIDEKICK_TOOL_NAME));
  };
  pi.on("model_select", (event) => { syncSidekick(event.model); });
  pi.on("input", (event) => { sidekick?.onInput(event.source); });
  pi.on("session_start", (_event, context) => {
    if (context.modelRegistry.getRegisteredNativeProvider("devin") !== provider) {
      provider.shutdown();
      throw new Error("The Devin provider ID collides with another registration. Remove the duplicate extension and reload.");
    }
    provider.attachSession({
      getSessionId: () => context.sessionManager.getSessionId(),
      getBranch: () => context.sessionManager.getBranch(),
      append: (data) => pi.appendEntry(DEVIN_STATE_ENTRY, data),
    });
    sidekick?.onSessionStart(context.sessionManager.getSessionId());
    syncSidekick(context.model);
    statusContext = context;
    refreshStatus(context);
  });
  pi.on("message_end", (event, context) => {
    if (event.message.role === "assistant" && event.message.provider === "devin") refreshStatus(context, event.message);
  });
  // Subagents and other sessions record quota in the shared store; any model's turn picks it up.
  pi.on("turn_end", (_event, context) => { refreshStatus(context); });
  pi.on("before_agent_start", () => { provider.lifecycle.begin("agent"); });
  pi.on("agent_start", () => { provider.lifecycle.agentStarted(); });
  // Host retry or overflow recovery can continue after agent_end.
  pi.on("agent_settled", (_event, context) => { provider.lifecycle.finish(); refreshStatus(context); });
  pi.on("session_before_compact", (event) => { provider.lifecycle.beforeCompaction(event.reason); });
  pi.on("session_compact", (event) => { provider.lifecycle.afterCompaction(event.reason); });
  pi.on("session_compact_failed", (event) => { provider.lifecycle.afterCompaction(event.reason); });
  pi.on("session_before_tree", (event) => { if (event.preparation.userWantsSummary) provider.lifecycle.beforeTree(); });
  pi.on("session_tree", (_event, context) => { provider.lifecycle.treeChanged(); refreshStatus(context); });
  pi.on("cache_warming_decision", (_event, context) => context.model?.provider === "devin" ? { action: "stop" } : undefined);
  pi.on("session_shutdown", () => { statusContext = undefined; sidekick?.reset(); provider.shutdown(); });
  return provider;
}
