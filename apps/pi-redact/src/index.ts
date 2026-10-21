import { createRedactor, type Redactor } from "@buyong/redact";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { TextCache } from "./cache.js";
import { createMaskEngine, type MaskEngine } from "./engine.js";
import { findMaskedWrite, MASKED_WRITE_REASON } from "./guard.js";
import { maskMessages, maskSessionEntriesInPlace, WITHHELD_TEXT } from "./messages.js";
import { REDACTION_MARKER } from "./render.js";
import { loadSettings } from "./settings.js";
import { maskToolResult, withheldToolResult } from "./tool-results.js";

const COMMAND_NAME = "pi-redact";
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

function createEngines(redactor: Redactor): Engines {
  return {
    stored: createMaskEngine(redactor),
    requests: createMaskEngine(redactor, new TextCache(REQUEST_CACHE_CHARACTERS, REQUEST_CACHE_ENTRIES)),
  };
}

interface SessionStats {
  toolResults: number;
  requests: number;
  summaries: number;
  blockedCalls: number;
  withheld: number;
}

const emptyStats = (): SessionStats => ({ toolResults: 0, requests: 0, summaries: 0, blockedCalls: 0, withheld: 0 });

export default function piRedact(pi: ExtensionAPI): void {
  // Built-in rules apply from the first hook; session_start adds the user's settings.
  let engines = createEngines(createRedactor());
  let sources: readonly string[] = [];
  let problems: readonly string[] = [];
  let stats = emptyStats();
  const reported = new Set<string>();

  /** Never throws: a failing notification must not stop a handler from returning its masked result. */
  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
    try {
      // Without a UI, Pi keeps stdout for its own output and moves other writes to stderr.
      if (ctx.hasUI) ctx.ui.notify(message, level);
      else process.stderr.write(`${message}\n`);
    } catch {}
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

  pi.on("session_start", async (_event, ctx) => {
    stats = emptyStats();
    reported.clear();
    const loaded = await loadSettings({
      agentDir: getAgentDir(),
      cwd: ctx.cwd,
      isProjectTrusted: ctx.isProjectTrusted(),
    });
    engines = createEngines(loaded.redactor);
    sources = loaded.sources;
    problems = loaded.problems;
    for (const problem of problems) report(ctx, problem, "warning");
  });

  pi.on("before_agent_start", (event) => {
    const guidelines = event.systemPromptOptions.promptGuidelines;
    if (!guidelines.includes(MODEL_GUIDELINE)) guidelines.push(MODEL_GUIDELINE);
  });

  pi.on("tool_result", (event, ctx) => {
    // Calls made by another tool (codemode) return to that tool, not the model;
    // the parent's own result and details are masked when it finishes.
    if (event.parentToolCallId !== undefined) return undefined;
    try {
      const result = maskToolResult(engines.stored, event);
      if (result) stats.toolResults++;
      return result;
    } catch {
      reportWithheld(ctx, 1, `a ${event.toolName} result`);
      return withheldToolResult();
    }
  });

  // Runs after every `context` handler, so text other extensions add is masked too.
  pi.on("context_with_system", (event, ctx) => {
    let masked: ReturnType<typeof maskMessages>;
    try {
      masked = maskMessages(engines.requests, event.messages);
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
    try {
      const preparation = event.preparation;
      const summarized = maskMessages(engines.requests, preparation.messagesToSummarize);
      const prefix = maskMessages(engines.requests, preparation.turnPrefixMessages);
      // Pi's compact() reads these fields after the hook returns.
      preparation.messagesToSummarize = summarized.messages;
      preparation.turnPrefixMessages = prefix.messages;
      if (preparation.previousSummary !== undefined)
        preparation.previousSummary = engines.requests.maskText(preparation.previousSummary);
      reportWithheld(ctx, summarized.withheldCount + prefix.withheldCount, "compaction");
      stats.summaries++;
      return undefined;
    } catch {
      report(ctx, "masking the compaction input failed; compaction was cancelled", "error");
      return { cancel: true };
    }
  });

  pi.on("session_before_tree", (event, ctx) => {
    if (!event.preparation.userWantsSummary) return undefined;
    try {
      const withheldCount = maskSessionEntriesInPlace(engines.requests, event.preparation.entriesToSummarize);
      reportWithheld(ctx, withheldCount, "a branch summary");
      stats.summaries++;
      return undefined;
    } catch {
      report(ctx, "masking the branch summary input failed; navigation was cancelled", "error");
      return { cancel: true };
    }
  });

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

  pi.registerCommand(COMMAND_NAME, {
    description: "Show pi-redact settings and what it masked in this session",
    handler: async (_args, ctx) => {
      const lines = [
        `pi-redact masks detected values as ${REDACTION_MARKER}.`,
        `Settings: ${sources.length ? sources.join(", ") : "built-in rules only"}`,
        ...problems.map((problem) => `Skipped: ${problem}`),
        `This session: ${stats.toolResults} tool results masked, ${stats.requests} model requests changed, ` +
          `${stats.summaries} summaries checked, ${stats.blockedCalls} calls blocked, ${stats.withheld} items withheld.`,
      ];
      notify(ctx, lines.join("\n"), "info");
    },
  });
}
