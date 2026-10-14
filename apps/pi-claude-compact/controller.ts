import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, isContextOverflow, type Model, type RetryPolicy, type Usage } from "@earendil-works/pi-ai";
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  CompactionEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  ProjectedSessionEntry,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionEntry,
  TurnEndEvent,
  TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { type ClaudeCompactConfig, loadConfig, modelKey, saveConfig } from "./config.ts";
import { type EngineSuccess, runCompactionEngine } from "./engine.ts";
import { startPrecompute, takePrecompute } from "./precompute.ts";
import { buildSummaryMessage, RAPID_REFILL_MESSAGE } from "./prompt.ts";
import {
  buildRestore,
  type CarriedRestore,
  EMPTY_CARRIED_RESTORE,
  renderRestore,
  restoredSkillBlocks,
} from "./restore.ts";
import {
  createSessionRuntime,
  discardPrecompute,
  evaluateRapidRefill,
  FAILURE_LIMIT,
  resetRunTracking,
  type SessionRuntime,
} from "./session-state.ts";
import { isMediaTooLarge, tokenGapFromError } from "./summarizer.ts";
import {
  type CompactThresholds,
  computeThresholds,
  contextLevel,
  formatTokens,
  percentLeftUntilCompact,
  type ThresholdResult,
} from "./thresholds.ts";
import { buildGroups, estimateMessagesTokens, groupMessages } from "./transcript.ts";

export const STATUS_KEY = "claude-compact";
const BRIDGE_BASE_URL = "claude-bridge";
/** claude-bridge's process-wide registry of "pi rewrote this session's history" hooks. */
const BRIDGE_REBUILD_HOOKS = Symbol.for("claude-bridge:markRebuildHooks");
/** Read by claude-bridge to stand its own compaction takeover down, per pi session. */
const CLAUDE_COMPACT_REGISTRY = Symbol.for("pi-claude-compact");
/** Claude Code offers a deeper pass only when the compacted context still has this many rounds. */
const DEEPER_PASS_MIN_GROUPS = 3;
const FIRST_PASS_ENTRY_ID = "claude-compact:first-pass";

interface OwnershipRegistry {
  owners: Map<string, () => boolean>;
  ownsCompaction(sessionId: string | null | undefined): boolean;
}

/** One registry per process; each loaded instance registers the sessions it serves. */
function ownershipRegistry(): OwnershipRegistry {
  const slots = globalThis as Record<symbol, unknown>;
  const existing = slots[CLAUDE_COMPACT_REGISTRY] as Partial<OwnershipRegistry> | undefined;
  if (existing?.owners instanceof Map && typeof existing.ownsCompaction === "function") {
    return existing as OwnershipRegistry;
  }
  const owners = new Map<string, () => boolean>();
  const registry: OwnershipRegistry = {
    owners,
    ownsCompaction: (sessionId) => (sessionId ? owners.get(sessionId)?.() === true : false),
  };
  slots[CLAUDE_COMPACT_REGISTRY] = registry;
  return registry;
}

/** "auto": the turn-boundary trigger. "media": recovery after a media-size rejection of the main request. */
type CompactTrigger = "auto" | "media" | SessionBeforeCompactEvent["reason"];

interface CompactRequest {
  entries: readonly ProjectedSessionEntry[];
  thresholds: CompactThresholds | undefined;
  /** Context size before compaction (provider usage or Pi's estimate): sizes the compacted context. */
  tokensBefore: number | undefined;
  customInstructions: string | undefined;
  initialTokenGap: number | undefined;
  signal: AbortSignal | undefined;
  allowPrecompute: boolean;
  /** lSe's allowFallback: Claude Code allows the head-trimming last resort only when blocked, on overflow, and for /compact. */
  allowLastResort: boolean;
  keepTrailingToolRound: boolean;
  trigger: CompactTrigger;
}

/** One finished summary, from the engine, a precompute, or a first pass plus a deeper pass. */
interface Compacted {
  rawSummary: string;
  usage: Usage;
  model: Model<Api>;
  firstKeptEntryId: string | null;
  keptMessages: AgentMessage[];
  summarizedMessages: AgentMessage[];
  headTruncated: boolean;
  attempts: number;
  groupsPreserved: number;
  totalGroups: number;
  precomputed: boolean;
  deeperPass: boolean;
}

interface CompactDetails {
  source: "claude-compact";
  trigger: CompactTrigger;
  model: string;
  attempts: number;
  groupsPreserved: number;
  totalGroups: number;
  headTruncated: boolean;
  precomputed: boolean;
  deeperPass: boolean;
  restoredFiles: string[];
  restoredSkills: { name: string; location: string }[];
}

type CompactOutcome =
  | { ok: true; summary: string; firstKeptEntryId: string | null; usage: Usage; details: CompactDetails }
  | { ok: false; reason: string; detail?: string };

type CompactSuccess = CompactOutcome & { ok: true };

function isBridgeModel(model: Model<Api> | undefined): boolean {
  return model?.baseUrl === BRIDGE_BASE_URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The error that triggered overflow recovery. Pi omits the failed reply from the projection, not the branch. */
function overflowError(branchEntries: readonly SessionEntry[]): string | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index]!;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    return entry.message.stopReason === "error" ? entry.message.errorMessage : undefined;
  }
  return undefined;
}

/** What the previous claude-compact compaction restored, so it stays part of the read state. */
function carriedRestore(entries: readonly ProjectedSessionEntry[]): CarriedRestore {
  const entry = entries[0]?.sourceEntry;
  if (entry?.type !== "compaction" || !isRecord(entry.details) || entry.details.source !== "claude-compact") {
    return EMPTY_CARRIED_RESTORE;
  }
  const files = Array.isArray(entry.details.restoredFiles)
    ? entry.details.restoredFiles.filter((path): path is string => typeof path === "string")
    : [];
  const skillLocations = new Set(
    Array.isArray(entry.details.restoredSkills)
      ? entry.details.restoredSkills.flatMap((skill) =>
          isRecord(skill) && typeof skill.location === "string" ? [skill.location] : [],
        )
      : [],
  );
  return { files, skills: skillLocations.size > 0 ? restoredSkillBlocks(entry.summary, skillLocations) : [] };
}

function endsWithToolResult(messages: readonly AgentMessage[]): boolean {
  return messages.at(-1)?.role === "toolResult";
}

function systemTokens(entries: readonly ProjectedSessionEntry[]): number {
  return estimateMessagesTokens(
    entries.flatMap((entry) => entry.messages.filter((message) => message.role === "system")),
  );
}

function failureText(reason: string, detail: string | undefined): string {
  return detail ? `${reason}: ${detail}` : reason;
}

function addUsage(first: Usage, second: Usage): Usage {
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    totalTokens: first.totalTokens + second.totalTokens,
    cost: {
      input: first.cost.input + second.cost.input,
      output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total,
    },
  };
}

function fromEngine(result: EngineSuccess, keptMessages: AgentMessage[], precomputed: boolean): Compacted {
  return {
    rawSummary: result.rawSummary,
    usage: result.usage,
    model: result.model,
    firstKeptEntryId: result.firstKeptEntryId,
    keptMessages,
    summarizedMessages: result.summarizedMessages,
    headTruncated: result.headTruncated,
    attempts: result.attempts,
    groupsPreserved: result.groupsPreserved,
    totalGroups: result.totalGroups,
    precomputed,
    deeperPass: false,
  };
}

/** The first-pass summary as the head of the context a deeper pass compacts again. */
function firstPassEntry(summary: string): ProjectedSessionEntry {
  const timestamp = Date.now();
  return {
    sourceEntry: {
      type: "compaction",
      id: FIRST_PASS_ENTRY_ID,
      parentId: null,
      timestamp: new Date(timestamp).toISOString(),
      summary,
      firstKeptEntryId: "",
      tokensBefore: 0,
    },
    messages: [{ role: "compactionSummary", summary, tokensBefore: 0, timestamp }],
  };
}

export class ClaudeCompactController {
  config: ClaudeCompactConfig;
  configWarnings: string[];
  private readonly pi: ExtensionAPI;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly registry = ownershipRegistry();
  private readonly owns = () => this.config.enabled;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    const loaded = loadConfig();
    this.config = loaded.config;
    this.configWarnings = loaded.warnings;
  }

  updateConfig(next: ClaudeCompactConfig): void {
    saveConfig(next);
    this.config = next;
    if (!next.enabled || !next.precompute) for (const runtime of this.sessions.values()) discardPrecompute(runtime);
  }

  thresholdsFor(model: Model<Api>): ThresholdResult {
    return computeThresholds(model, this.config.models[modelKey(model)]);
  }

  runtimeFor(ctx: ExtensionContext): SessionRuntime {
    const id = ctx.sessionManager.getSessionId();
    let runtime = this.sessions.get(id);
    if (!runtime) {
      runtime = createSessionRuntime();
      this.sessions.set(id, runtime);
    }
    return runtime;
  }

  startSession(ctx: ExtensionContext): void {
    const id = ctx.sessionManager.getSessionId();
    const runtime = this.sessions.get(id);
    if (runtime) discardPrecompute(runtime);
    this.sessions.set(id, createSessionRuntime());
    this.registry.owners.set(id, this.owns);
  }

  endSession(ctx: ExtensionContext): void {
    const id = ctx.sessionManager.getSessionId();
    const runtime = this.sessions.get(id);
    if (runtime) discardPrecompute(runtime);
    this.sessions.delete(id);
    if (this.registry.owners.get(id) === this.owns) this.registry.owners.delete(id);
  }

  invalidatePrecompute(ctx: ExtensionContext): void {
    const runtime = this.sessions.get(ctx.sessionManager.getSessionId());
    if (runtime) discardPrecompute(runtime);
  }

  /** The run settled: the next prompt starts a new query with fresh breakers. */
  endRun(ctx: ExtensionContext): void {
    const runtime = this.sessions.get(ctx.sessionManager.getSessionId());
    if (runtime) resetRunTracking(runtime);
  }

  resolveModel(ctx: ExtensionContext, reference: string): Model<Api> | undefined {
    const slash = reference.indexOf("/");
    if (slash <= 0) return undefined;
    return ctx.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1));
  }

  /** Summarizer first, then the conversation model as the fallback for non-size errors. */
  summarizerModels(ctx: ExtensionContext, runtime: SessionRuntime): Model<Api>[] {
    const conversation = ctx.model;
    let configured: Model<Api> | undefined;
    if (this.config.summaryModel) {
      configured = this.resolveModel(ctx, this.config.summaryModel);
      if (!configured && !runtime.summaryModelNotified) {
        runtime.summaryModelNotified = true;
        ctx.ui.notify(
          `claude-compact: summary model ${this.config.summaryModel} is not available; using the conversation model`,
          "warning",
        );
      }
    }
    const primary = configured ?? conversation;
    if (!primary) return [];
    const models = [primary];
    if (
      configured &&
      conversation &&
      this.config.fallbackToConversationModel &&
      modelKey(configured) !== modelKey(conversation)
    ) {
      models.push(conversation);
    }
    return models;
  }

  private retryPolicy(): RetryPolicy | undefined {
    const retry = (this.pi.getSettings() as { retry?: Record<string, unknown> }).retry;
    if (!retry) return undefined;
    return {
      enabled: typeof retry.enabled === "boolean" ? retry.enabled : true,
      maxRetries: typeof retry.maxRetries === "number" ? retry.maxRetries : 3,
      baseDelayMs: typeof retry.baseDelayMs === "number" ? retry.baseDelayMs : 2_000,
      ...(typeof retry.maxAgentDelayMs === "number" ? { maxAgentDelayMs: retry.maxAgentDelayMs } : {}),
    };
  }

  /** Earlier boundary drafts change the context the compaction would replace: measure that preview. */
  private boundaryTokens(ctx: ExtensionContext, event: TurnEndEvent): number {
    if (event.entries.length > 0) return estimateMessagesTokens(event.context.contextMessages);
    return ctx.getContextUsage()?.tokens ?? estimateMessagesTokens(event.context.contextMessages);
  }

  private updateStatus(ctx: ExtensionContext, tokens: number, thresholds: CompactThresholds): void {
    const level = contextLevel(tokens, thresholds);
    if (level === "ok") ctx.ui.setStatus(STATUS_KEY, undefined);
    else {
      const left = percentLeftUntilCompact(tokens, thresholds);
      ctx.ui.setStatus(
        STATUS_KEY,
        `${left}% until compact (${formatTokens(tokens)}/${formatTokens(thresholds.threshold)})`,
      );
    }
  }

  /** Boundary compactions bypass session_compact, which is where claude-bridge rebuilds on its own. */
  private notifyBridgeRewrite(ctx: ExtensionContext, boundary: string): void {
    if (!isBridgeModel(ctx.model)) return;
    const hooks = (globalThis as Record<symbol, unknown>)[BRIDGE_REBUILD_HOOKS];
    if (!(hooks instanceof Set)) return;
    for (const hook of hooks) {
      if (typeof hook === "function") hook(ctx.sessionManager.getSessionId(), `claude-compact:${boundary}`);
    }
  }

  private summaryText(ctx: ExtensionContext, compacted: Compacted): string {
    return buildSummaryMessage(compacted.rawSummary, {
      transcriptPath: ctx.sessionManager.getSessionFile(),
      headTruncated: compacted.headTruncated,
      preservedTail: compacted.keptMessages.length > 0,
    });
  }

  /** Size of the context the compaction produces: what is not a message today, the kept tail, the summary. */
  private projectedTokens(request: CompactRequest, keptMessages: readonly AgentMessage[], summary: string): number {
    const overhead =
      request.tokensBefore === undefined
        ? systemTokens(request.entries)
        : Math.max(0, request.tokensBefore - estimateMessagesTokens(groupMessages(buildGroups(request.entries))));
    return overhead + estimateMessagesTokens(keptMessages) + Math.ceil(summary.length / 4);
  }

  private async finish(
    ctx: ExtensionContext,
    request: CompactRequest,
    compacted: Compacted,
  ): Promise<{ outcome: CompactSuccess; projectedTokens: number }> {
    const restore = await buildRestore(
      ctx.cwd,
      compacted.summarizedMessages,
      compacted.keptMessages,
      carriedRestore(request.entries),
      request.signal,
    );
    const restoreText = renderRestore(restore);
    const summaryMessage = this.summaryText(ctx, compacted);
    const summary = restoreText ? `${summaryMessage}\n\n${restoreText}` : summaryMessage;
    return {
      projectedTokens: this.projectedTokens(request, compacted.keptMessages, summary),
      outcome: {
        ok: true,
        summary,
        firstKeptEntryId: compacted.firstKeptEntryId,
        usage: compacted.usage,
        details: {
          source: "claude-compact",
          trigger: request.trigger,
          model: modelKey(compacted.model),
          attempts: compacted.attempts,
          groupsPreserved: compacted.groupsPreserved,
          totalGroups: compacted.totalGroups,
          headTruncated: compacted.headTruncated,
          precomputed: compacted.precomputed,
          deeperPass: compacted.deeperPass,
          restoredFiles: restore.files.map((file) => file.path),
          restoredSkills: restore.skills.map((skill) => ({ name: skill.name, location: skill.location })),
        },
      },
    };
  }

  /**
   * Claude Code's deeper pass: when the compacted context would still be over the blocking limit, compact
   * it once more (its summary plus the kept rounds). Pi retries an overflow only once, and its own
   * preparation finds nothing to compact right after a compaction, so the second pass runs here.
   */
  private async deeperPass(
    ctx: ExtensionContext,
    runtime: SessionRuntime,
    request: CompactRequest,
    first: Compacted,
    projectedTokens: number,
  ): Promise<Compacted | undefined> {
    const thresholds = request.thresholds;
    if (thresholds === undefined || request.trigger === "media" || first.precomputed) return undefined;
    if (projectedTokens < thresholds.blocking || first.firstKeptEntryId === null) return undefined;
    const keptFrom = request.entries.findIndex((entry) => entry.sourceEntry.id === first.firstKeptEntryId);
    if (keptFrom < 0) return undefined;
    const groups = buildGroups([firstPassEntry(this.summaryText(ctx, first)), ...request.entries.slice(keptFrom)]);
    if (groups.length < DEEPER_PASS_MIN_GROUPS) return undefined;
    const overage = projectedTokens - thresholds.contextWindow;
    const second = await runCompactionEngine({
      groups,
      models: this.summarizerModels(ctx, runtime),
      registry: ctx.modelRegistry,
      customInstructions: request.customInstructions,
      initialTokenGap: overage > 0 ? overage : undefined,
      allowFallback: true,
      keepTrailingToolRound: request.keepTrailingToolRound,
      signal: request.signal,
      retry: this.retryPolicy(),
    });
    if (!second.ok) return undefined;
    return {
      rawSummary: second.rawSummary,
      usage: addUsage(first.usage, second.usage),
      model: second.model,
      firstKeptEntryId: second.firstKeptEntryId,
      keptMessages: second.keptMessages,
      summarizedMessages: [
        ...first.summarizedMessages,
        ...second.summarizedMessages.filter((message) => message.role !== "compactionSummary"),
      ],
      headTruncated: first.headTruncated || second.headTruncated,
      attempts: first.attempts + second.attempts,
      groupsPreserved: second.groupsPreserved,
      totalGroups: first.totalGroups,
      precomputed: false,
      deeperPass: true,
    };
  }

  private async compactOnce(
    ctx: ExtensionContext,
    runtime: SessionRuntime,
    request: CompactRequest,
  ): Promise<CompactOutcome> {
    if (request.allowPrecompute) {
      const taken = await takePrecompute(runtime, request.entries, request.signal);
      if (!taken.ok && taken.reason === "aborted") return { ok: false, reason: "aborted" };
      if (taken.ok) {
        const finished = await this.finish(ctx, request, fromEngine(taken.result, taken.keptMessages, true));
        if (request.signal?.aborted) return { ok: false, reason: "aborted" };
        // $xr's would-not-fit check, on the context the compaction actually produces.
        if (request.thresholds === undefined || finished.projectedTokens < request.thresholds.threshold) {
          return finished.outcome;
        }
      }
    } else {
      discardPrecompute(runtime);
    }

    const engine = await runCompactionEngine({
      groups: buildGroups(request.entries),
      models: this.summarizerModels(ctx, runtime),
      registry: ctx.modelRegistry,
      customInstructions: request.customInstructions,
      initialTokenGap: request.initialTokenGap,
      allowFallback: request.allowLastResort,
      keepTrailingToolRound: request.keepTrailingToolRound,
      signal: request.signal,
      retry: this.retryPolicy(),
    });
    if (!engine.ok) return { ok: false, reason: engine.reason, detail: engine.detail };
    const first = fromEngine(engine, engine.keptMessages, false);
    let finished = await this.finish(ctx, request, first);
    if (request.signal?.aborted) return { ok: false, reason: "aborted" };
    const deeper = await this.deeperPass(ctx, runtime, request, first, finished.projectedTokens);
    if (request.signal?.aborted) return { ok: false, reason: "aborted" };
    if (deeper) {
      finished = await this.finish(ctx, request, deeper);
      if (request.signal?.aborted) return { ok: false, reason: "aborted" };
    }
    return finished.outcome;
  }

  private async compact(
    ctx: ExtensionContext,
    runtime: SessionRuntime,
    request: CompactRequest,
  ): Promise<CompactOutcome> {
    runtime.compacting = true;
    try {
      return await this.compactOnce(ctx, runtime, request);
    } catch (error) {
      if (request.signal?.aborted) return { ok: false, reason: "aborted" };
      return { ok: false, reason: "error", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      runtime.compacting = false;
    }
  }

  private compactionDraft(outcome: CompactSuccess): CompactionEntryDraft {
    return {
      type: "compaction",
      summary: outcome.summary,
      firstKeptEntryId: outcome.firstKeptEntryId,
      details: outcome.details,
      usage: outcome.usage,
    };
  }

  /** Main trigger: compact at a turn boundary without aborting the run (Claude Code's autocompact). */
  async onTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): Promise<TurnEndEventResult | undefined> {
    if (!this.config.enabled) return undefined;
    const model = ctx.model;
    if (!model || event.outcome !== "completed") return undefined;
    const runtime = this.runtimeFor(ctx);
    runtime.rapid.turnCounter++;

    const thresholdResult = this.thresholdsFor(model);
    if (!thresholdResult.ok) {
      if (!runtime.thresholdErrorNotified) {
        runtime.thresholdErrorNotified = true;
        ctx.ui.notify(`claude-compact: ${modelKey(model)}: ${thresholdResult.error}`, "warning");
      }
      return undefined;
    }
    const thresholds = thresholdResult.value;
    const entries = event.context.contextEntries;
    const tokens = this.boundaryTokens(ctx, event);
    this.updateStatus(ctx, tokens, thresholds);

    if (tokens < thresholds.threshold) {
      if (this.config.precompute && tokens >= thresholds.precompute) {
        startPrecompute(runtime, {
          entries,
          models: this.summarizerModels(ctx, runtime),
          registry: ctx.modelRegistry,
          retry: this.retryPolicy(),
        });
      }
      return undefined;
    }
    if (runtime.compacting) return undefined;
    if (this.failureBreakerOpen(ctx, runtime)) return undefined;
    const rapid = evaluateRapidRefill(runtime.rapid);
    if (rapid.trip) {
      this.tripRapidRefill(ctx, runtime, rapid.consecutive);
      return undefined;
    }

    ctx.ui.setStatus(STATUS_KEY, `compacting ${formatTokens(tokens)}...`);
    try {
      const outcome = await this.compact(ctx, runtime, {
        entries,
        thresholds,
        tokensBefore: tokens,
        customInstructions: undefined,
        initialTokenGap: undefined,
        signal: ctx.signal,
        allowPrecompute: this.config.precompute,
        allowLastResort: contextLevel(tokens, thresholds) === "blocked",
        keepTrailingToolRound: isBridgeModel(model) && endsWithToolResult(event.context.contextMessages),
        trigger: "auto",
      });
      if (!outcome.ok) {
        if (outcome.reason !== "aborted") {
          runtime.consecutiveFailures++;
          ctx.ui.notify(
            `claude-compact: auto-compaction failed (${failureText(outcome.reason, outcome.detail)})`,
            "warning",
          );
        }
        return undefined;
      }
      this.recordSuccess(runtime, rapid.consecutive);
      this.notifyBridgeRewrite(ctx, "turn_end");
      return { entries: [...event.entries, this.compactionDraft(outcome)] };
    } finally {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }

  /**
   * Claude Code compacts and retries when the main request is rejected for media size. Pi neither
   * retries nor compacts these (unless it classifies them as overflow), so the run would end here:
   * drop the failed reply, compact without the head-trimming last resort, and ask Pi to continue.
   */
  async onBeforeSettle(
    event: AgentBeforeSettleEvent,
    ctx: ExtensionContext,
  ): Promise<AgentBeforeSettleEventResult | undefined> {
    if (!this.config.enabled || event.outcome !== "error") return undefined;
    const model = ctx.model;
    if (!model) return undefined;
    const runtime = this.runtimeFor(ctx);
    if (runtime.compacting || runtime.mediaRecoveryAttempted) return undefined;

    const entries = event.context.contextEntries;
    const failedIndex = entries.findLastIndex((entry) =>
      entry.messages.some((message) => message.role === "assistant"),
    );
    const failed = entries[failedIndex]?.messages.find((message) => message.role === "assistant");
    if (failed?.role !== "assistant" || failed.stopReason !== "error") return undefined;
    if (!isMediaTooLarge(failed.errorMessage ?? "") || isContextOverflow(failed)) return undefined;
    runtime.mediaRecoveryAttempted = true;

    const rapid = evaluateRapidRefill(runtime.rapid);
    if (rapid.trip) {
      runtime.rapid = { ...runtime.rapid, consecutiveRapidRefills: rapid.consecutive };
      ctx.ui.notify(RAPID_REFILL_MESSAGE, "error");
      return undefined;
    }

    const failedEntryId = entries[failedIndex]!.sourceEntry.id;
    const remaining = entries.filter((_entry, index) => index !== failedIndex);
    const thresholdResult = this.thresholdsFor(model);
    ctx.ui.setStatus(STATUS_KEY, "compacting after a media-size error...");
    try {
      const outcome = await this.compact(ctx, runtime, {
        entries: remaining,
        thresholds: thresholdResult.ok ? thresholdResult.value : undefined,
        tokensBefore: undefined,
        customInstructions: undefined,
        initialTokenGap: undefined,
        signal: ctx.signal,
        allowPrecompute: false,
        allowLastResort: false,
        keepTrailingToolRound: isBridgeModel(model) && endsWithToolResult(remaining.flatMap((entry) => entry.messages)),
        trigger: "media",
      });
      if (!outcome.ok) {
        // Claude Code surfaces the original error; a failed reactive compaction does not count toward the breaker.
        if (outcome.reason !== "aborted") {
          ctx.ui.notify(
            `claude-compact: media-error recovery failed (${failureText(outcome.reason, outcome.detail)})`,
            "warning",
          );
        }
        return undefined;
      }
      this.recordSuccess(runtime, rapid.consecutive);
      this.notifyBridgeRewrite(ctx, "agent_before_settle");
      return {
        entries: [
          ...event.entries,
          { type: "context_edit", targetId: failedEntryId, replacement: null },
          this.compactionDraft(outcome),
        ],
        continue: true,
      };
    } finally {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }

  /** Pi-initiated compaction (its own threshold, overflow recovery, /compact) runs through the same engine. */
  async onBeforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<SessionBeforeCompactResult | undefined> {
    if (!this.config.enabled) return undefined;
    const model = ctx.model;
    if (!model) return undefined;
    const bridge = isBridgeModel(model);
    const runtime = this.runtimeFor(ctx);
    if (runtime.compacting) return { cancel: true };

    // Claude Code's autocompact checks both breakers and its reactive path the rapid-refill one;
    // /compact bypasses them and leaves the query's tracking alone.
    let consecutiveRapidRefills = 0;
    if (event.reason !== "manual") {
      if (event.reason === "threshold" && this.failureBreakerOpen(ctx, runtime)) return { cancel: true };
      const rapid = evaluateRapidRefill(runtime.rapid);
      if (rapid.trip) {
        this.tripRapidRefill(ctx, runtime, rapid.consecutive);
        return { cancel: true };
      }
      consecutiveRapidRefills = rapid.consecutive;
    }

    const projection = ctx.sessionManager.buildSessionProjection();
    const thresholdResult = this.thresholdsFor(model);
    const thresholds = thresholdResult.ok ? thresholdResult.value : undefined;
    const tokensBefore = event.preparation.tokensBefore;
    const customInstructions = event.customInstructions?.trim() ? event.customInstructions : undefined;
    const error = event.reason === "overflow" ? overflowError(event.branchEntries) : undefined;
    let allowLastResort = true;
    if (event.reason === "threshold") {
      allowLastResort = thresholds === undefined || contextLevel(tokensBefore, thresholds) === "blocked";
    } else if (event.reason === "overflow") {
      // Pi counts request_too_large as an overflow; Claude Code treats it as a media error.
      allowLastResort = error === undefined || !isMediaTooLarge(error);
    }

    const outcome = await this.compact(ctx, runtime, {
      entries: projection.entries,
      thresholds,
      tokensBefore,
      customInstructions,
      initialTokenGap: error === undefined ? undefined : tokenGapFromError(error),
      signal: event.signal,
      allowPrecompute: this.config.precompute && customInstructions === undefined,
      allowLastResort,
      keepTrailingToolRound: bridge && endsWithToolResult(projection.messages),
      trigger: event.reason,
    });

    if (outcome.ok) {
      if (event.reason !== "manual") this.recordSuccess(runtime, consecutiveRapidRefills);
      return {
        compaction: {
          summary: outcome.summary,
          firstKeptEntryId: outcome.firstKeptEntryId ?? "",
          tokensBefore,
          usage: outcome.usage,
          details: outcome.details,
        },
      };
    }
    if (outcome.reason === "aborted") return { cancel: true };
    // Only the autocompact path counts toward the failure breaker (Claude Code's Pon).
    if (event.reason === "threshold") runtime.consecutiveFailures++;
    if (outcome.reason === "too_few_groups") {
      if (event.reason === "manual") ctx.ui.notify("Not enough messages to compact.", "warning");
    } else {
      ctx.ui.notify(`claude-compact: compaction failed (${failureText(outcome.reason, outcome.detail)})`, "error");
    }
    // claude-bridge models hang in Pi's own summarizer; elsewhere Pi's compaction is the auto safety net.
    if (bridge || event.reason === "manual") return { cancel: true };
    return undefined;
  }

  private failureBreakerOpen(ctx: ExtensionContext, runtime: SessionRuntime): boolean {
    if (runtime.consecutiveFailures < FAILURE_LIMIT) return false;
    if (!runtime.failureBreakerNotified) {
      runtime.failureBreakerNotified = true;
      ctx.ui.notify(
        `claude-compact: auto-compaction stopped for this run after ${FAILURE_LIMIT} consecutive failures; overflow recovery and /compact still run`,
        "warning",
      );
    }
    return true;
  }

  private tripRapidRefill(ctx: ExtensionContext, runtime: SessionRuntime, consecutive: number): void {
    runtime.rapid = { ...runtime.rapid, consecutiveRapidRefills: consecutive };
    ctx.ui.notify(RAPID_REFILL_MESSAGE, "error");
    ctx.abort();
  }

  private recordSuccess(runtime: SessionRuntime, consecutiveRapidRefills: number): void {
    runtime.consecutiveFailures = 0;
    runtime.failureBreakerNotified = false;
    runtime.rapid = { compacted: true, turnCounter: 0, consecutiveRapidRefills };
  }
}
