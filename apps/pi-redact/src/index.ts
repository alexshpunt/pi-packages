import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { analyticsPath } from "./analytics.js";
import { createAnalyticsSession } from "./analytics-session.js";
import { makeMaskingSession } from "./masking-session.js";
import { registerRedactCommands } from "./pi/commands.js";
import { createRedactController } from "./pi/controller.js";
import { createSessionFeedback } from "./pi/feedback.js";
import { registerMaskingHooks } from "./pi/hooks.js";
import { registerSessionLifecycle } from "./pi/session.js";

/** Assemble one extension instance. Files and SQLite remain lazy until a session or command needs them. */
export default function piRedact(pi: ExtensionAPI): void {
  const analytics = createAnalyticsSession(() => analyticsPath(getAgentDir()));
  const masking = Effect.runSync(makeMaskingSession(analytics.observe));
  const feedback = createSessionFeedback();

  registerSessionLifecycle(pi, masking, analytics, feedback);
  registerMaskingHooks(pi, masking, analytics, feedback);
  registerRedactCommands(pi, createRedactController(pi, masking, analytics, feedback));
}
