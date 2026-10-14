import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactCommand, registerModelCommand } from "./commands.ts";
import { ClaudeCompactController, STATUS_KEY } from "./controller.ts";

export default function claudeCompact(pi: ExtensionAPI): void {
  const controller = new ClaudeCompactController(pi);

  let warningsShown = false;
  pi.on("session_start", (_event, ctx) => {
    // Also registers this session as owned in the registry claude-bridge reads.
    controller.startSession(ctx);
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (!warningsShown && controller.configWarnings.length > 0) {
      warningsShown = true;
      ctx.ui.notify(`claude-compact config:\n${controller.configWarnings.join("\n")}`, "warning");
    }
  });
  pi.on("session_shutdown", (_event, ctx) => controller.endSession(ctx));
  pi.on("session_tree", (_event, ctx) => controller.invalidatePrecompute(ctx));
  pi.on("session_compact", (_event, ctx) => controller.invalidatePrecompute(ctx));

  pi.on("turn_end", (event, ctx) => controller.onTurnEnd(event, ctx));
  pi.on("agent_before_settle", (event, ctx) => controller.onBeforeSettle(event, ctx));
  pi.on("agent_settled", (_event, ctx) => controller.endRun(ctx));
  pi.on("session_before_compact", (event, ctx) => controller.onBeforeCompact(event, ctx));

  registerCompactCommand(pi, controller);
  registerModelCommand(pi, controller);
}
