import { createRedactor, type Redactor } from "@buyong/redact";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { AnalyticsStore, analyticsPath, type RedactionEvent, type RedactionSource } from "./analytics.js";
import { TextCache } from "./cache.js";
import { ANALYTICS_COMMAND, type RedactController, registerRedactCommands } from "./commands.js";
import { createMaskEngine, type MaskEngine, type MaskObservation } from "./engine.js";
import { findMaskedWrite, MASKED_WRITE_REASON } from "./guard.js";
import { maskMessages, maskSessionEntriesInPlace, WITHHELD_TEXT } from "./messages.js";
import { notify } from "./notify.js";
import { REDACTION_MARKER } from "./render.js";
import { restoreSessionChoice, SESSION_CHOICE_ENTRY, sessionChoiceData } from "./session-choice.js";
import {
  EMPTY_SETTINGS_DOCUMENT,
  globalSettingsPath,
  type LoadedSettings,
  loadSettings,
  projectSettingsPath,
  readSettingsFile,
  writeSettingsFile,
} from "./settings.js";
import { type AnalyticsCounts, emptyStats } from "./status.js";
import { maskToolResult, withheldToolResult } from "./tool-results.js";
import { errorText } from "./ui/common.js";

const STATUS_KEY = "pi-redact";
/** Repeated model requests reuse results for up to this many characters of distinct text. */
const REQUEST_CACHE_CHARACTERS = 8 * 1024 * 1024;
const REQUEST_CACHE_ENTRIES = 50_000;
const MODEL_GUIDELINE =
  `Text shown as ${REDACTION_MARKER} replaces a sensitive value that pi-redact masked before it reached you; ` +
  "the real value still exists locally. Never write it into files or commands. Edit around such lines, " +
  "or ask the user to supply the value.";

interface Engines {
  /** Tool results, masked once before they are stored. */
  readonly stored: MaskEngine;
  /** Model requests and summaries, which repeat the same history and use a cache. */
  readonly requests: MaskEngine;
}

export default function piRedact(pi: ExtensionAPI): void {
  let redactor: Redactor = createRedactor();
  let disabledRules: readonly string[] = [];
  // Built-in rules apply from the first hook; session_start adds the user's settings.
  let engines = createEngines();
  let isEnabledByDefault = true;
  /** This session's own choice from `/redact`; `undefined` follows the global default. */
  let sessionChoice: boolean | undefined;
  let sources: readonly string[] = [];
  let problems: readonly string[] = [];
  let stats = emptyStats();
  const reported = new Set<string>();
  let analytics: AnalyticsStore | undefined;
  /** The step that is masking right now; observations outside a step are not recorded. */
  let currentSource: RedactionSource | undefined;
  let pendingEvents: RedactionEvent[] = [];

  const isEnabled = () => sessionChoice ?? isEnabledByDefault;

  function observe(observation: MaskObservation): void {
    if (currentSource === undefined) return;
    const { label, fieldName } = observation;
    pendingEvents.push({
      source: currentSource,
      label: fieldName === undefined ? label : `${label} · ${fieldName}`,
      before: observation.before,
      after: observation.after,
      ruleIds: observation.ruleIds,
    });
  }

  function createEngines(): Engines {
    const options = { disabledRules, observe };
    return {
      stored: createMaskEngine(redactor, undefined, options),
      requests: createMaskEngine(redactor, new TextCache(REQUEST_CACHE_CHARACTERS, REQUEST_CACHE_ENTRIES), options),
    };
  }

  function analyticsStore(): AnalyticsStore {
    analytics ??= new AnalyticsStore(analyticsPath(getAgentDir()));
    return analytics;
  }

  /** Notify once per session for each distinct problem. */
  function report(ctx: ExtensionContext, message: string, level: "warning" | "error"): void {
    if (reported.has(message)) return;
    reported.add(message);
    notify(ctx, `pi-redact: ${message}`, level);
  }

  function reportWithheld(ctx: ExtensionContext, count: number, where: string): void {
    if (count === 0) return;
    stats.withheld += count;
    report(ctx, `masking failed for ${where}; the affected content was withheld instead of sent`, "error");
  }

  /** Run one masking step and save what it changed for `/redact-analytics`. Saving never affects masking. */
  function recorded<T>(ctx: ExtensionContext, source: RedactionSource, mask: () => T): T {
    currentSource = source;
    try {
      return mask();
    } finally {
      currentSource = undefined;
      const events = pendingEvents;
      pendingEvents = [];
      if (events.length)
        try {
          analyticsStore().record({ sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd }, events);
        } catch (error) {
          report(ctx, `masked content could not be saved for /${ANALYTICS_COMMAND}: ${errorText(error)}`, "warning");
        }
    }
  }

  function updateStatusBar(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      const text = sessionChoice === undefined ? "redact off" : "redact off (this session)";
      ctx.ui.setStatus(STATUS_KEY, isEnabled() ? undefined : ctx.ui.theme.fg("warning", text));
    } catch {}
  }

  function applySettings(loaded: LoadedSettings): void {
    redactor = loaded.redactor;
    disabledRules = loaded.disabledRules;
    engines = createEngines();
    isEnabledByDefault = loaded.isEnabledByDefault;
    sources = loaded.sources;
    problems = loaded.problems;
  }

  async function reloadSettings(ctx: ExtensionContext): Promise<void> {
    applySettings(
      await loadSettings({ agentDir: getAgentDir(), cwd: ctx.cwd, isProjectTrusted: ctx.isProjectTrusted() }),
    );
    updateStatusBar(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    stats = emptyStats();
    reported.clear();
    analytics?.close();
    analytics = undefined;
    sessionChoice = restoreSessionChoice(ctx.sessionManager.getBranch());
    await reloadSettings(ctx);
    for (const problem of problems) report(ctx, problem, "warning");
  });

  pi.on("session_tree", (_event, ctx) => {
    sessionChoice = restoreSessionChoice(ctx.sessionManager.getBranch());
    updateStatusBar(ctx);
  });

  pi.on("session_shutdown", () => {
    analytics?.close();
    analytics = undefined;
  });

  pi.on("before_agent_start", (event) => {
    // Kept while masking is off: the history can still contain the marker, and the prompt stays cacheable.
    const guidelines = event.systemPromptOptions.promptGuidelines;
    if (!guidelines.includes(MODEL_GUIDELINE)) guidelines.push(MODEL_GUIDELINE);
  });

  pi.on("tool_result", (event, ctx) => {
    if (!isEnabled()) return undefined;
    // Calls made by another tool (codemode) return to that tool, not the model;
    // the parent's own result and details are masked when it finishes.
    if (event.parentToolCallId !== undefined) return undefined;
    try {
      const result = recorded(ctx, "tool result", () => maskToolResult(engines.stored, event));
      if (result) stats.toolResults++;
      return result;
    } catch {
      reportWithheld(ctx, 1, `a ${event.toolName} result`);
      return withheldToolResult();
    }
  });

  // Runs after every `context` handler, so text other extensions add is masked too.
  pi.on("context_with_system", (event, ctx) => {
    if (!isEnabled()) return undefined;
    let masked: ReturnType<typeof maskMessages>;
    try {
      masked = recorded(ctx, "model request", () => maskMessages(engines.requests, event.messages));
    } catch {
      // Even withholding single messages failed: stop the run and send nothing from the conversation.
      try {
        ctx.abort();
      } catch {}
      reportWithheld(ctx, event.messages.length, "a model request");
      const system = event.messages.filter((message) => message.role === "system");
      return { messages: [...system, { role: "user", content: WITHHELD_TEXT, timestamp: Date.now() }] };
    }
    reportWithheld(ctx, masked.withheldCount, "a model request");
    if (masked.messages === event.messages) return undefined;
    stats.requests++;
    return { messages: masked.messages };
  });

  // Compaction and branch summaries call the model without the context hooks.
  pi.on("session_before_compact", (event, ctx) => {
    if (!isEnabled()) return undefined;
    try {
      const preparation = event.preparation;
      const { summarized, prefix } = recorded(ctx, "compaction", () => ({
        summarized: maskMessages(engines.requests, preparation.messagesToSummarize),
        prefix: maskMessages(engines.requests, preparation.turnPrefixMessages),
      }));
      // Pi's compact() reads these fields after the hook returns.
      preparation.messagesToSummarize = summarized.messages;
      preparation.turnPrefixMessages = prefix.messages;
      const previousSummary = preparation.previousSummary;
      if (previousSummary !== undefined)
        preparation.previousSummary = recorded(ctx, "compaction", () =>
          engines.requests.labeled("previous compaction summary", () => engines.requests.maskText(previousSummary)),
        );
      reportWithheld(ctx, summarized.withheldCount + prefix.withheldCount, "compaction");
      stats.summaries++;
      return undefined;
    } catch {
      report(ctx, "masking the compaction input failed; compaction was cancelled", "error");
      return { cancel: true };
    }
  });

  pi.on("session_before_tree", (event, ctx) => {
    if (!isEnabled() || !event.preparation.userWantsSummary) return undefined;
    try {
      const withheldCount = recorded(ctx, "branch summary", () =>
        maskSessionEntriesInPlace(engines.requests, event.preparation.entriesToSummarize),
      );
      reportWithheld(ctx, withheldCount, "a branch summary");
      stats.summaries++;
      return undefined;
    } catch {
      report(ctx, "masking the branch summary input failed; navigation was cancelled", "error");
      return { cancel: true };
    }
  });

  // The write guard stays on while masking is off: earlier results in the history can still hold the marker.
  pi.on("tool_call", async (event, ctx) => {
    let target: string | undefined;
    try {
      target = await findMaskedWrite(event, ctx.cwd);
    } catch {
      return { block: true, reason: `pi-redact could not check this ${event.toolName} call for ${REDACTION_MARKER}.` };
    }
    if (target === undefined) return undefined;
    stats.blockedCalls++;
    if (ctx.hasUI) notify(ctx, `pi-redact blocked writing ${REDACTION_MARKER} to ${target}`, "warning");
    return { block: true, reason: MASKED_WRITE_REASON };
  });

  const controller: RedactController = {
    status(ctx) {
      let counts: AnalyticsCounts;
      try {
        const store = analyticsStore();
        counts = { session: store.count({ sessionId: ctx.sessionManager.getSessionId() }), all: store.count({}) };
      } catch (error) {
        counts = { error: `the analytics file could not be read: ${errorText(error)}` };
      }
      return {
        isEnabled: isEnabled(),
        sessionChoice,
        isEnabledByDefault,
        globalSettingsPath: globalSettingsPath(getAgentDir()),
        sources,
        problems,
        disabledRules,
        stats: { ...stats },
        analytics: counts,
      };
    },

    setSessionEnabled(ctx, isOn) {
      pi.appendEntry(SESSION_CHOICE_ENTRY, sessionChoiceData(isOn));
      sessionChoice = isOn;
      updateStatusBar(ctx);
    },

    async setGlobalEnabled(ctx, isOn) {
      const path = globalSettingsPath(getAgentDir());
      const file = await readSettingsFile(path, "global");
      if (file.state === "invalid")
        throw new Error(`${path} cannot be changed: ${file.problems.join("; ")}. Fix or delete it first.`);
      const document = file.state === "valid" ? file.document : EMPTY_SETTINGS_DOCUMENT;
      await writeSettingsFile(path, "global", { ...document, enabled: isOn });
      await reloadSettings(ctx);
    },

    async customTargets(ctx) {
      const globalPath = globalSettingsPath(getAgentDir());
      const projectPath = projectSettingsPath(ctx.cwd);
      const isTrusted = ctx.isProjectTrusted();
      return [
        { scope: "global", path: globalPath, file: await readSettingsFile(globalPath, "global") },
        {
          scope: "project",
          path: projectPath,
          file: isTrusted ? await readSettingsFile(projectPath, "project") : { state: "missing" },
          ...(isTrusted ? {} : { unavailableReason: "Trust this project in Pi (/trust) to edit its settings here." }),
        },
      ];
    },

    async saveSettings(ctx, scope, document) {
      if (scope === "project" && !ctx.isProjectTrusted())
        throw new Error("Project settings apply only in a trusted project.");
      const path = scope === "global" ? globalSettingsPath(getAgentDir()) : projectSettingsPath(ctx.cwd);
      await writeSettingsFile(path, scope, document);
      await reloadSettings(ctx);
    },

    preview(text) {
      const ruleIds = new Set<string>();
      const engine = createMaskEngine(redactor, undefined, {
        disabledRules,
        observe: (observation) => {
          for (const ruleId of observation.ruleIds) ruleIds.add(ruleId);
        },
      });
      return { masked: engine.maskText(text), ruleIds: [...ruleIds] };
    },

    analytics() {
      return {
        list: (scope, limit) => analyticsStore().list(scope, limit),
        summarize: (scope) => analyticsStore().summarize(scope),
        get: (id) => analyticsStore().get(id),
        clear: (scope) => analyticsStore().clear(scope),
      };
    },
  };

  registerRedactCommands(pi, controller);
}
