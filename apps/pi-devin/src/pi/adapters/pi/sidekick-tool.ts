import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, type ManagedRuntime } from "effect";
import type { DevinError } from "../../../core/errors.ts";
import { SIDEKICK_REPORT_MESSAGE, SIDEKICK_TOOL_NAME } from "../../features/sidekick/prompts.ts";
import { SidekickHost, Sidekicks } from "../../features/sidekick/service.ts";

/** The lead Pi as the sidekick sees it. */
export const PiSidekickHost = (pi: ExtensionAPI) => Layer.succeed(SidekickHost, {
  activeTools: Effect.sync(() => pi.getActiveTools()),
  deliverReport: (report) => Effect.sync(() => {
    pi.sendMessage({ customType: SIDEKICK_REPORT_MESSAGE, display: true, content: report.content, details: report.details }, { deliverAs: "followUp", triggerTurn: true });
  }),
});

/**
 * The lead's `devin_sidekick` tool. The sidekick runs as one child Pi process per lead session and uses the lead's active tools.
 * By default it waits for the report; with `block: false`, or when a user message arrives while waiting, it moves to the background and delivers the report once.
 */
export function sidekickTool(runtime: ManagedRuntime.ManagedRuntime<Sidekicks, DevinError>): ToolDefinition {
  const sidekicks = runtime.runSync(Sidekicks);
  return {
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
    execute: (_toolCallId, params, signal, onUpdate, ctx) => runtime.runPromise(sidekicks.handoff({
      params, model: ctx.model, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), isSessionSaved: Boolean(ctx.sessionManager.getSessionFile()), signal,
      onProgress: (text, details) => onUpdate?.({ content: [{ type: "text", text }], details }),
    })),
  };
}
