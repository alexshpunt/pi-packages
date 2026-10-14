import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { type ClaudeCompactConfig, configPath, modelKey } from "./config.ts";
import type { ClaudeCompactController } from "./controller.ts";
import {
  piCompactionView,
  piReserveFor,
  piSettingsPath,
  projectReserveOverrides,
  projectSettingsPath,
  writePiReserveOverrides,
} from "./pi-settings.ts";
import {
  type CompactThresholds,
  computeThresholds,
  formatTokens,
  type ModelCompactSetting,
  parseTokenAmount,
  piNativeThreshold,
  safetyNetReserveTokens,
} from "./thresholds.ts";

const COMPACT_SUBCOMMANDS: AutocompleteItem[] = [
  { value: "status", label: "status", description: "Thresholds, summarizer, and Pi safety net per model" },
  { value: "threshold", label: "threshold", description: "Set a model's compaction threshold or window" },
  { value: "safety-net", label: "safety-net", description: "Move Pi's own trigger above claude-compact's" },
  { value: "on", label: "on", description: "Enable the engine" },
  { value: "off", label: "off", description: "Disable the engine (Pi's own compaction takes over)" },
  { value: "precompute", label: "precompute", description: "Toggle background precompute (on|off)" },
];

/** Scoped models (or every available one when unscoped), with the conversation model first. */
export function candidateModels(ctx: ExtensionContext): Model<Api>[] {
  const scoped = ctx.scopedModels.map((scopedModel) => scopedModel.model);
  const pool = scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
  const models = ctx.model ? [ctx.model, ...pool] : pool;
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = modelKey(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describeThresholds(thresholds: CompactThresholds): string {
  return [
    `compact at ${formatTokens(thresholds.threshold)} of window ${formatTokens(thresholds.window)}`,
    `warn ${formatTokens(thresholds.warning)}`,
    `block ${formatTokens(thresholds.blocking)}`,
    `precompute ${formatTokens(thresholds.precompute)}`,
    `context ${formatTokens(thresholds.contextWindow)}`,
  ].join(", ");
}

function piNetNote(thresholds: CompactThresholds, piThreshold: number): string {
  return piThreshold < thresholds.threshold
    ? `Pi fires first at ${formatTokens(piThreshold)}`
    : `Pi net at ${formatTokens(piThreshold)}`;
}

function statusText(ctx: ExtensionContext, controller: ClaudeCompactController, pi: ExtensionAPI): string {
  const { config } = controller;
  const view = piCompactionView(pi.getSettings());
  const summarizer = config.summaryModel ?? "conversation model";
  const lines = [
    `claude-compact ${config.enabled ? "enabled" : "disabled"} · precompute ${config.precompute ? "on" : "off"} · summarizer ${summarizer}${config.summaryModel ? ` (fallback ${config.fallbackToConversationModel ? "on" : "off"})` : ""}`,
    `config ${configPath()}`,
  ];
  if (!view.enabled) lines.push("warning: Pi's compaction.enabled is false, so overflow recovery is off");
  const usage = ctx.getContextUsage();
  if (ctx.model && usage?.tokens != null) {
    const current = controller.thresholdsFor(ctx.model);
    if (current.ok) {
      lines.push(
        `current ${modelKey(ctx.model)}: ${formatTokens(usage.tokens)} used, compact at ${formatTokens(current.value.threshold)}`,
      );
    }
  }
  lines.push("");
  for (const model of candidateModels(ctx)) {
    const key = modelKey(model);
    const result = controller.thresholdsFor(model);
    if (!result.ok) {
      lines.push(`${key}: ${result.error}`);
      continue;
    }
    const source = result.value.source === "default" ? "" : ` [${result.value.source}]`;
    const piThreshold = piNativeThreshold(model.contextWindow, piReserveFor(view, key));
    lines.push(`${key}${source}: ${describeThresholds(result.value)}; ${piNetNote(result.value, piThreshold)}`);
  }
  for (const warning of controller.configWarnings) lines.push(`config warning: ${warning}`);
  return lines.join("\n");
}

async function pickModel(ctx: ExtensionCommandContext, title: string, reference: string | undefined) {
  const models = candidateModels(ctx);
  if (reference) {
    const model = models.find((candidate) => modelKey(candidate) === reference);
    if (!model) ctx.ui.notify(`claude-compact: unknown or unscoped model ${reference}`, "error");
    return model;
  }
  const labels = models.map((model) => `${modelKey(model)}  (context ${formatTokens(model.contextWindow)})`);
  const choice = await ctx.ui.select(title, labels);
  return choice === undefined ? undefined : models[labels.indexOf(choice)];
}

async function configureThreshold(
  ctx: ExtensionCommandContext,
  controller: ClaudeCompactController,
  reference: string | undefined,
): Promise<void> {
  const model = await pickModel(ctx, "Model to configure", reference);
  if (!model) return;
  const key = modelKey(model);
  const current = controller.config.models[key] ?? {};
  const options = [
    "Set threshold (tokens like 600k, or percent of the effective window like 80%)",
    "Set compaction window (Claude Code autoCompactWindow, at most the context window)",
    "Use the Claude Code default (clear overrides)",
  ];
  const choice = await ctx.ui.select(`Compaction for ${key}`, options);
  if (choice === undefined) return;

  let next: ModelCompactSetting | undefined;
  if (choice === options[2]) next = undefined;
  else {
    const isWindow = choice === options[1];
    const raw = await ctx.ui.input(
      isWindow ? `Compaction window for ${key}` : `Threshold for ${key}`,
      isWindow ? `${formatTokens(model.contextWindow)} or less` : "e.g. 600k or 80%",
    );
    if (raw === undefined || raw.trim() === "") return;
    const parsed = parseTokenAmount(raw);
    if (!parsed || (isWindow && parsed.kind !== "tokens")) {
      ctx.ui.notify(`claude-compact: "${raw}" is not ${isWindow ? "a token amount" : "tokens or a percent"}`, "error");
      return;
    }
    next = isWindow
      ? { ...current, window: parsed.value }
      : { ...current, threshold: parsed.kind === "percent" ? `${parsed.value}%` : parsed.value };
  }

  const result = computeThresholds(model, next);
  if (!result.ok) {
    ctx.ui.notify(`claude-compact: ${key}: ${result.error}`, "error");
    return;
  }
  const confirmed = await ctx.ui.confirm(`Apply to ${key}?`, describeThresholds(result.value));
  if (!confirmed) return;
  const models = { ...controller.config.models };
  if (next) models[key] = next;
  else delete models[key];
  controller.updateConfig({ ...controller.config, models });
  ctx.ui.notify(`claude-compact: ${key}: ${describeThresholds(result.value)}`, "info");
}

async function alignSafetyNet(
  ctx: ExtensionCommandContext,
  controller: ClaudeCompactController,
  pi: ExtensionAPI,
): Promise<void> {
  const view = piCompactionView(pi.getSettings());
  const projectOverrides = projectReserveOverrides(ctx.cwd);
  const reserveUpdates: Record<string, number> = {};
  const migrated: Record<string, ModelCompactSetting> = {};
  const lines: string[] = [];
  for (const model of candidateModels(ctx)) {
    const key = modelKey(model);
    const ours = controller.thresholdsFor(model);
    if (!ours.ok) continue;
    const piReserve = piReserveFor(view, key);
    const piThreshold = piNativeThreshold(model.contextWindow, piReserve);
    if (piThreshold >= ours.value.threshold) continue;
    const targetReserve = safetyNetReserveTokens(model.maxTokens);
    reserveUpdates[key] = targetReserve;
    let line = `${key}: Pi fires at ${formatTokens(piThreshold)}, before ${formatTokens(ours.value.threshold)}; Pi reserve ${formatTokens(piReserve)} -> ${formatTokens(targetReserve)} (Pi fires at ${formatTokens(piNativeThreshold(model.contextWindow, targetReserve))})`;
    const ownSetting = controller.config.models[key];
    if (
      view.modelOverrides[key] !== undefined &&
      ownSetting?.threshold === undefined &&
      ownSetting?.window === undefined
    ) {
      const candidate: ModelCompactSetting = { threshold: piThreshold };
      if (computeThresholds(model, candidate).ok) {
        migrated[key] = candidate;
        line += `; claude-compact threshold <- ${formatTokens(piThreshold)} (keeps your previous trigger)`;
      }
    }
    if (projectOverrides.has(key)) {
      line += `; warning: ${projectSettingsPath(ctx.cwd)} also overrides this model and keeps winning until you change it there`;
    }
    lines.push(line);
  }
  if (!view.enabled) {
    ctx.ui.notify(
      `claude-compact: Pi's compaction.enabled is false in ${piSettingsPath()}; overflow recovery is off until it is re-enabled`,
      "warning",
    );
  }
  if (lines.length === 0) {
    ctx.ui.notify("claude-compact: Pi's own trigger already sits at or above claude-compact's for every model", "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(`Update ${piSettingsPath()}?`, lines.join("\n"));
  if (!confirmed) return;
  writePiReserveOverrides(reserveUpdates);
  if (Object.keys(migrated).length > 0) {
    controller.updateConfig({ ...controller.config, models: { ...controller.config.models, ...migrated } });
  }
  ctx.ui.notify(
    "claude-compact: Pi safety net updated. Restart Pi (or /reload) so Pi's own trigger picks up the new reserve.",
    "info",
  );
}

function setFlag(
  ctx: ExtensionCommandContext,
  controller: ClaudeCompactController,
  flag: "enabled" | "precompute",
  value: boolean,
): void {
  const next: ClaudeCompactConfig = { ...controller.config, [flag]: value };
  controller.updateConfig(next);
  ctx.ui.notify(`claude-compact: ${flag === "enabled" ? "engine" : "precompute"} ${value ? "on" : "off"}`, "info");
}

export function registerCompactCommand(pi: ExtensionAPI, controller: ClaudeCompactController): void {
  pi.registerCommand("claude-compact", {
    description: "Claude Code-style compaction: status, per-model thresholds, Pi safety net, on/off",
    getArgumentCompletions: (prefix) => {
      if (prefix.startsWith("precompute ")) {
        return ["on", "off"].map((value) => ({ value: `precompute ${value}`, label: value }));
      }
      return COMPACT_SUBCOMMANDS.filter((item) => item.value.startsWith(prefix.trim()));
    },
    handler: async (args, ctx) => {
      const [subcommand = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      let action = subcommand;
      if (action === "") {
        const options = COMPACT_SUBCOMMANDS.map((item) => `${item.label}: ${item.description}`);
        const choice = await ctx.ui.select("claude-compact", options);
        if (choice === undefined) return;
        action = COMPACT_SUBCOMMANDS[options.indexOf(choice)]!.value;
      }
      switch (action) {
        case "status":
          ctx.ui.notify(statusText(ctx, controller, pi), "info");
          return;
        case "threshold":
          await configureThreshold(ctx, controller, rest[0]);
          return;
        case "safety-net":
          await alignSafetyNet(ctx, controller, pi);
          return;
        case "on":
          setFlag(ctx, controller, "enabled", true);
          return;
        case "off":
          setFlag(ctx, controller, "enabled", false);
          return;
        case "precompute": {
          const value = rest[0] === undefined ? !controller.config.precompute : rest[0] === "on";
          setFlag(ctx, controller, "precompute", value);
          return;
        }
        default:
          ctx.ui.notify(`claude-compact: unknown subcommand "${action}"`, "error");
      }
    },
  });
}

function summarizerWindowWarnings(
  ctx: ExtensionContext,
  controller: ClaudeCompactController,
  model: Model<Api>,
): string[] {
  const warnings: string[] = [];
  for (const candidate of candidateModels(ctx)) {
    const result = controller.thresholdsFor(candidate);
    if (!result.ok || model.contextWindow >= result.value.threshold) continue;
    warnings.push(
      `${modelKey(candidate)} compacts at ${formatTokens(result.value.threshold)}, above this model's ${formatTokens(model.contextWindow)} window: the engine will keep more recent rounds or trim the oldest ones`,
    );
  }
  return warnings;
}

async function chooseSummaryModel(
  ctx: ExtensionCommandContext,
  controller: ClaudeCompactController,
  model: Model<Api> | null,
): Promise<void> {
  if (model) {
    const warnings = summarizerWindowWarnings(ctx, controller, model);
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      warnings.unshift(`no stored credentials for ${model.provider}; extension providers may still work`);
    }
    if (warnings.length > 0) {
      const proceed = await ctx.ui.confirm(`Use ${modelKey(model)} for summaries?`, warnings.join("\n"));
      if (!proceed) return;
    }
  }
  controller.updateConfig({ ...controller.config, summaryModel: model ? modelKey(model) : null });
  ctx.ui.notify(`claude-compact: summaries use ${model ? modelKey(model) : "the conversation model"}`, "info");
}

export function registerModelCommand(pi: ExtensionAPI, controller: ClaudeCompactController): void {
  pi.registerCommand("claude-compact-model", {
    description: "Choose the summarization model: the conversation model or a scoped model",
    getArgumentCompletions: (prefix) => {
      const items: AutocompleteItem[] = [
        { value: "current", label: "current", description: "Use the conversation model" },
        { value: "fallback on", label: "fallback on", description: "Retry with the conversation model on failure" },
        { value: "fallback off", label: "fallback off", description: "Do not retry with the conversation model" },
      ];
      return items.filter((item) => item.value.startsWith(prefix.trim()));
    },
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument === "current") return chooseSummaryModel(ctx, controller, null);
      if (argument === "fallback on" || argument === "fallback off") {
        controller.updateConfig({ ...controller.config, fallbackToConversationModel: argument === "fallback on" });
        ctx.ui.notify(`claude-compact: fallback to the conversation model ${argument.slice(9)}`, "info");
        return;
      }
      if (argument !== "") {
        const model = controller.resolveModel(ctx, argument);
        if (!model) {
          ctx.ui.notify(`claude-compact: unknown model ${argument}`, "error");
          return;
        }
        return chooseSummaryModel(ctx, controller, model);
      }

      const { config } = controller;
      const models = candidateModels(ctx);
      const current = ctx.model ? modelKey(ctx.model) : "none";
      const conversationOption = `Conversation model (now ${current})${config.summaryModel === null ? "  [selected]" : ""}`;
      const modelOptions = models.map(
        (model) =>
          `${modelKey(model)}  (context ${formatTokens(model.contextWindow)})${config.summaryModel === modelKey(model) ? "  [selected]" : ""}`,
      );
      const fallbackOption = `Fallback to the conversation model on failure: ${config.fallbackToConversationModel ? "on" : "off"} (toggle)`;
      const choice = await ctx.ui.select("Summarization model", [conversationOption, ...modelOptions, fallbackOption]);
      if (choice === undefined) return;
      if (choice === conversationOption) return chooseSummaryModel(ctx, controller, null);
      if (choice === fallbackOption) {
        controller.updateConfig({ ...config, fallbackToConversationModel: !config.fallbackToConversationModel });
        ctx.ui.notify(
          `claude-compact: fallback to the conversation model ${config.fallbackToConversationModel ? "off" : "on"}`,
          "info",
        );
        return;
      }
      return chooseSummaryModel(ctx, controller, models[modelOptions.indexOf(choice)]!);
    },
  });
}
