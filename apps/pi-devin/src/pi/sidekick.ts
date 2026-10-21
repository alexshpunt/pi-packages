import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEVIN_API, type DevinModel } from "./models.ts";
import type { DevinProvider } from "./provider.ts";
import { boundReport, type BoundedReport } from "./sidekick-report.ts";
import { SidekickRuntime, type Handoff, type HandoffReport, type SidekickLaunch, type SidekickRuntimeOptions } from "./sidekick-runtime.ts";

export const SIDEKICK_TOOL_NAME = "devin_sidekick";
/** Marker set on the child Pi started as the sidekick. The child's extension does not register Fusion again. */
export const FUSION_CHILD_ENV = "PI_DEVIN_FUSION_CHILD";
/** Custom message type that delivers a background handoff report to the lead. */
export const SIDEKICK_REPORT_MESSAGE = "devin-sidekick-report";
/** Appended by the provider to Fusion lead requests only, so a custom system prompt cannot drop it. */
export const FUSION_LEAD_GUIDANCE = [
  `Fusion mode: you are the lead. Plan, talk to the user, and decide; delegate hands-on exploration, implementation, and verification to the \`${SIDEKICK_TOOL_NAME}\` tool with clear context and done criteria.`,
  `The sidekick is a separate agent in this workspace with the same tools, and it keeps its context across handoffs. \`${SIDEKICK_TOOL_NAME}\` waits for the report by default; pass \`block: false\` to keep working while it runs, and its report arrives later as a message. Calling \`${SIDEKICK_TOOL_NAME}\` while it is busy adds instructions to the running handoff.`,
  "Review its report critically, decide the next step, and do not redo work it already reported. Present the combined result as your own work.",
].join("\n");
const SYSTEM_PROMPT = [
  "You are the sidekick: a hands-on software engineer paired with a lead agent in the same workspace.",
  "The lead sends you briefs with context and done criteria and may add instructions while you work. Do the work with the available tools: explore, implement, and verify.",
  "You cannot talk to the user. When you finish, reply without tool calls with a concise report: what you did, how you verified it, and anything unresolved or risky.",
  "Your conversation persists across briefs from the same lead session, so build on what you already know.",
].join("\n");

export interface SidekickDetails {
  sidekickModel: string;
  handoffId: string;
  status: HandoffReport["status"] | "running" | "background";
  toolCalls: number;
  durationMs?: number;
  isSteer: boolean;
  /** Complete report saved when the text the lead received was cut. */
  fullReportPath?: string;
}

export interface SidekickToolOptions {
  /** Pi agent directory that holds sidekick session files. */
  agentDir: () => string;
  /** Lets tests replace how the child is started. */
  runtime?: Omit<SidekickRuntimeOptions, "childEnv" | "onProgress">;
}

/** The host may copy model objects in its settings layer, so Fusion data is looked up by id in the provider's current list. */
export function fusionOf(provider: Pick<DevinProvider, "getModels">, model: Model<any> | undefined): NonNullable<DevinModel["devin"]["fusion"]> | undefined {
  if (model?.provider !== "devin" || model.api !== DEVIN_API) return undefined;
  return (provider.getModels() as readonly DevinModel[]).find((candidate) => candidate.id === model.id)?.devin.fusion;
}

const launchKey = (launch: SidekickLaunch) => JSON.stringify([launch.cwd, launch.modelID, launch.thinking, launch.sessionFile, launch.tools]);
const shortID = (id: string) => id.slice(0, 8);

/** Bound and preserve the complete report, including status, errors and any background delivery heading. */
async function reportText(report: HandoffReport, heading = ""): Promise<BoundedReport> {
  const body = report.text.trim();
  const reason = report.error ?? (report.status === "aborted" ? "cancelled." : "failed.");
  const text = report.status === "completed" ? body || "(The sidekick finished without a report.)"
    : [`The sidekick task ${report.status === "aborted" ? "stopped" : "failed"}: ${reason}`, body].filter(Boolean).join("\n\n");
  return boundReport(heading + text);
}

interface ReportDelivery {
  owner: "background" | "blocking" | "delivered";
  scheduled: boolean;
}

const reportPath = (fullReportPath: string | undefined) => fullReportPath ? { fullReportPath } : {};

/**
 * The lead's `devin_sidekick` tool. The sidekick runs as one child Pi process per lead session and uses the lead's active tools.
 * By default it waits for the report; with `block: false`, or when a user message arrives while waiting, it moves to the background and delivers the report once.
 */
export function createSidekickTool(pi: ExtensionAPI, provider: DevinProvider, options: SidekickToolOptions) {
  const runtimes = new Map<string, SidekickRuntime>();
  // Steers share the same done promise; completed handoffs must not be retained by delivery bookkeeping.
  const deliveries = new WeakMap<Promise<HandoffReport>, ReportDelivery>();
  const waits = new Set<() => void>();
  let progressListener: (() => void) | undefined;

  const deliverLater = (handoff: Handoff, runtime: SidekickRuntime, delivery: ReportDelivery) => {
    if (delivery.scheduled || delivery.owner === "delivered") return;
    delivery.scheduled = true;
    void handoff.done.then(async (report) => {
      try {
        // A blocking call owns the report unless user input moves it back to the background.
        const canDeliver = () => delivery.owner === "background" && [...runtimes.values()].includes(runtime);
        if (report.status === "aborted" || !canDeliver()) return;
        const { text, fullReportPath } = await reportText(report, `Sidekick report for background handoff ${shortID(report.id)}:\n\n`);
        if (!canDeliver()) return;
        delivery.owner = "delivered";
        pi.sendMessage({
          customType: SIDEKICK_REPORT_MESSAGE, display: true, content: text,
          details: { sidekickModel: runtime.launch.modelID, handoffId: report.id, status: report.status, toolCalls: report.toolCalls, durationMs: report.durationMs, isSteer: false,
            ...reportPath(fullReportPath) } satisfies SidekickDetails,
        }, { deliverAs: "followUp", triggerTurn: true });
      } finally { delivery.scheduled = false; }
    });
  };

  const definition: ToolDefinition = {
    name: SIDEKICK_TOOL_NAME,
    label: "Sidekick",
    description: "Delegate hands-on work to your persistent sidekick, a separate coding agent that shares this workspace and your tools. "
      + "Put the task context and done criteria in `message`. By default the call waits and returns the sidekick's report; "
      + "set `block` to false to continue while it works, and the report arrives later as a message. "
      + "Calling it while the sidekick is busy adds instructions to the running handoff.",
    promptSnippet: "Delegate hands-on work to a persistent sidekick agent and get its report",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Brief for the sidekick: context, the task, and done criteria." },
        block: { type: "boolean", description: "Wait for the report (default true). Use false to keep working while the sidekick runs." },
      },
      required: ["message"],
      additionalProperties: false,
    } as unknown as ToolDefinition["parameters"],
    defaultActive: false,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      const fusion = fusionOf(provider, ctx.model);
      if (!fusion) throw new Error("The sidekick is only available with the Devin Fusion model.");
      const input = params as { message?: unknown; block?: unknown } | undefined;
      const message = typeof input?.message === "string" ? input.message.trim() : "";
      if (!message) throw new Error("A message for the sidekick is required.");
      // The lead list hides exact UIDs covered by groups, so the level comes from the Fusion candidates.
      const sidekickChoice = provider.getFusionChoices()?.sidekicks.find((item) => item.id === fusion.sidekickID);
      if (!sidekickChoice) throw new Error("The sidekick model is not in the current Devin model list. Refresh the model list.");
      const sessionId = ctx.sessionManager.getSessionId();
      const launch: SidekickLaunch = {
        cwd: ctx.cwd, modelID: fusion.sidekickID, thinking: sidekickChoice.level,
        sessionFile: ctx.sessionManager.getSessionFile() ? join(options.agentDir(), "pi-devin", "sidekick", `${sessionId}.jsonl`) : undefined,
        tools: pi.getActiveTools().filter((name) => name !== SIDEKICK_TOOL_NAME),
        systemPrompt: SYSTEM_PROMPT,
      };
      let runtime = runtimes.get(sessionId);
      // When the pair or tools change, only an idle process is restarted. Context continues through the same session file.
      if (runtime && !runtime.isBusy() && launchKey(runtime.launch) !== launchKey(launch)) { runtime.close(); runtime = undefined; }
      if (!runtime) {
        runtime = new SidekickRuntime(launch, { ...options.runtime, childEnv: { [FUSION_CHILD_ENV]: "1" }, onProgress: () => progressListener?.() });
        runtimes.set(sessionId, runtime);
      }
      signal?.throwIfAborted();
      const handoff = runtime.handoff(message);
      let delivery = deliveries.get(handoff.done);
      if (!delivery) {
        delivery = { owner: "background", scheduled: false };
        deliveries.set(handoff.done, delivery);
      }
      const details = (status: SidekickDetails["status"], report?: HandoffReport): SidekickDetails => ({
        sidekickModel: launch.modelID, handoffId: handoff.id, status, toolCalls: report?.toolCalls ?? runtime!.progress()?.toolCalls ?? 0,
        ...(report ? { durationMs: report.durationMs } : {}), isSteer: handoff.isSteer,
      });
      const backgroundResult = (reason: string) => {
        deliverLater(handoff, runtime!, delivery);
        return { content: [{ type: "text" as const, text: `${reason} The report will arrive as a message. (handoff ${shortID(handoff.id)})` }], details: details("background") };
      };
      if (input?.block === false) {
        return backgroundResult(handoff.isSteer ? "Added instructions to the running sidekick task." : "The sidekick started working in the background.");
      }
      delivery.owner = "blocking";
      let settle!: (outcome: "done" | "aborted" | "interrupted") => void;
      const waiting = new Promise<"done" | "aborted" | "interrupted">((resolve) => { settle = resolve; });
      const interrupt = () => settle("interrupted"), abort = () => settle("aborted");
      waits.add(interrupt);
      signal?.addEventListener("abort", abort, { once: true });
      progressListener = () => {
        const progress = runtime!.progress();
        if (progress) onUpdate?.({ content: [{ type: "text", text: `sidekick: ${progress.toolCalls} tool calls${progress.recentTools.length ? ` · ${progress.recentTools.join(", ")}` : ""}` }], details: details("running") });
      };
      if (signal?.aborted) abort();
      void handoff.done.then(() => settle("done"));
      const outcome = await waiting.finally(() => {
        progressListener = undefined;
        waits.delete(interrupt);
        signal?.removeEventListener("abort", abort);
      });
      if (outcome === "interrupted") {
        delivery.owner = "background";
        return backgroundResult("A user message arrived, so the sidekick task moved to the background.");
      }
      delivery.owner = "delivered";
      if (outcome === "aborted") {
        runtime.abort();
        throw new Error("Cancelled the sidekick task.");
      }
      const report = await handoff.done;
      const { text, fullReportPath } = await reportText(report);
      if (report.status !== "completed") throw new Error(text);
      return { content: [{ type: "text" as const, text }], details: { ...details(report.status, report), ...reportPath(fullReportPath) } };
    },
  };

  return {
    definition,
    /** On user input, a waiting handoff moves to the background. Input sent by extensions does not count. */
    onInput(source: string): void {
      if (source === "extension") return;
      for (const interrupt of [...waits]) interrupt();
    },
    /** Cleans up the sidekick of a different lead session. */
    onSessionStart(sessionId: string): void {
      for (const [id, runtime] of runtimes) if (id !== sessionId) { runtime.close(); runtimes.delete(id); }
    },
    reset(): void {
      for (const runtime of runtimes.values()) runtime.close();
      runtimes.clear();
    },
  };
}
