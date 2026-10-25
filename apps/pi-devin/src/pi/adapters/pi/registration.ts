import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, type Layer } from "effect";
import { failWith } from "../../../core/validation.ts";
import { ExtensionConfig } from "../../app/config.ts";
import type { ExtensionEnvironment } from "../../app/layer.ts";
import { makeExtensionRuntime, type ExtensionServices } from "../../app/runtime.ts";
import { attachSession, shutdownProvider } from "../../app/session.ts";
import { fusionOf } from "../../features/catalog/fusion.ts";
import { ModelCatalog } from "../../features/catalog/service.ts";
import { Runs } from "../../features/runs/service.ts";
import { DEVIN_STATE_ENTRY } from "../../features/runs/state.ts";
import { SIDEKICK_TOOL_NAME } from "../../features/sidekick/prompts.ts";
import { Sidekicks } from "../../features/sidekick/service.ts";
import { registerDevinCommand } from "./devin-command.ts";
import { registerFusionCommand } from "./fusion-command.ts";
import { makeDevinProvider } from "./provider.ts";
import { PiSidekickHost, sidekickTool } from "./sidekick-tool.ts";
import type { DevinExtension } from "./types.ts";
import { UsageStatus } from "./usage-status.ts";

/**
 * Registers one extension instance: its runtime, the provider, and, for the lead, the sidekick tool, `/devin` and `/devin-fusion`.
 * Pi's event handlers run their effects synchronously and return after the services finished, so the next event sees the result.
 * A failed layer build throws here, before anything is registered.
 */
export function registerDevinExtension(pi: ExtensionAPI, environment: Layer.Layer<ExtensionEnvironment>): DevinExtension {
  const runtime = makeExtensionRuntime(environment, PiSidekickHost(pi));
  const run = <A, E>(effect: Effect.Effect<A, E, ExtensionServices>) => runtime.runSync(effect);
  const { isFusionChild } = run(ExtensionConfig);
  const isLead = !isFusionChild;
  const provider = makeDevinProvider(runtime);
  const catalog = run(ModelCatalog), runs = run(Runs), sidekicks = run(Sidekicks), status = run(UsageStatus);
  pi.registerProvider(provider);
  if (isLead) {
    registerDevinCommand(pi, runtime);
    pi.registerTool(sidekickTool(runtime));
    registerFusionCommand(pi, runtime);
  }
  // Enables the sidekick only for the Fusion model and leaves other extensions' and the user's active tools alone.
  const syncSidekick = (model: Model<any> | undefined) => {
    if (!isLead) return;
    const active = pi.getActiveTools(), isActive = active.includes(SIDEKICK_TOOL_NAME);
    const shouldBeActive = fusionOf(run(catalog.models), model) !== undefined;
    if (shouldBeActive && !isActive) pi.setActiveTools([...active, SIDEKICK_TOOL_NAME]);
    else if (!shouldBeActive && isActive) pi.setActiveTools(active.filter((name) => name !== SIDEKICK_TOOL_NAME));
  };
  // Pi sets the new model before this event, so the status line follows it at once.
  pi.on("model_select", (event, context) => {
    syncSidekick(event.model);
    run(status.update(context));
  });
  pi.on("input", (event) => { if (isLead) run(sidekicks.userInput(event.source)); });
  pi.on("session_start", (_event, context) => {
    if (context.modelRegistry.getRegisteredNativeProvider("devin") !== provider) {
      run(shutdownProvider);
      run(failWith("The Devin provider ID collides with another registration. Remove the duplicate extension and reload."));
    }
    run(attachSession({
      getSessionId: () => context.sessionManager.getSessionId(),
      getBranch: () => context.sessionManager.getBranch(),
      append: (data) => pi.appendEntry(DEVIN_STATE_ENTRY, data),
    }));
    if (isLead) run(sidekicks.sessionStarted(context.sessionManager.getSessionId()));
    syncSidekick(context.model);
    run(Effect.andThen(status.bind(context), status.update(context)));
  });
  pi.on("message_end", (event, context) => {
    if (event.message.role === "assistant" && event.message.provider === "devin") run(status.update(context, event.message));
  });
  // Subagents and other sessions record quota in the shared store; any model's turn picks it up.
  pi.on("turn_end", (_event, context) => { run(status.update(context)); });
  pi.on("before_agent_start", () => { run(runs.begin("agent")); });
  pi.on("agent_start", () => { run(runs.agentStarted); });
  // Host retry or overflow recovery can continue after agent_end.
  pi.on("agent_settled", (_event, context) => { run(Effect.andThen(runs.finish, status.update(context))); });
  pi.on("session_before_compact", (event) => { run(runs.beforeCompaction(event.reason)); });
  pi.on("session_compact", (event) => { run(runs.afterCompaction(event.reason)); });
  pi.on("session_compact_failed", (event) => { run(runs.afterCompaction(event.reason)); });
  pi.on("session_before_tree", (event) => { if (event.preparation.userWantsSummary) run(runs.beforeTree); });
  pi.on("session_tree", (_event, context) => { run(Effect.andThen(runs.treeChanged, status.update(context))); });
  pi.on("cache_warming_decision", (_event, context) => context.model?.provider === "devin" ? { action: "stop" } : undefined);
  pi.on("session_shutdown", () => {
    run(status.bind(undefined));
    if (isLead) run(sidekicks.reset);
    run(shutdownProvider);
  });
  return { provider, runtime };
}
