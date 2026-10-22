import type { spawn } from "node:child_process";
import type { Deferred, Effect } from "effect";
import type { DevinError, DevinFailure } from "../../../core/errors.ts";

export interface SidekickCommand { command: string; args: string[] }

/** Launch settings of the sidekick child Pi. When they change, the process restarts before the next handoff. */
export interface SidekickLaunch {
  cwd: string;
  /** Devin model ID of the exact variant (its catalog UID). */
  modelID: string;
  thinking?: string;
  /** Without it, the child starts with `--no-session`. */
  sessionFile?: string;
  tools: readonly string[];
  systemPrompt: string;
}

export interface HandoffProgress { toolCalls: number; recentTools: string[]; elapsedMs: number }
export interface HandoffReport {
  id: string;
  status: "completed" | "aborted" | "error";
  text: string;
  toolCalls: number;
  durationMs: number;
  error?: string;
}
/** A handoff and its single report. A steer shares the running handoff's report. */
export interface Handoff { id: string; done: Deferred.Deferred<HandoffReport>; isSteer: boolean }

export interface BoundedReport {
  text: string;
  /** Private temporary file with the complete report, set only when the report was cut and the file was written. */
  fullReportPath?: string;
}

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

/** How a sidekick child Pi is started. */
export interface SidekickLauncherShape {
  /** Command that runs Pi. The default is the same Node and Pi CLI as the lead. */
  readonly resolveCommand: Effect.Effect<SidekickCommand, DevinError>;
  /**
   * Starts the child. Node's spawner is used directly rather than Effect's: the child stays in the lead's process group,
   * so terminal signals reach it, and a broken stdin is noticed while writing.
   */
  readonly spawn: typeof spawn;
  readonly env: NodeJS.ProcessEnv;
  /** Passed to the child with `-e`, so it loads the same extension copy as the lead. */
  readonly packageRoot: string;
}

/** What the sidekick needs from the lead Pi. */
export interface SidekickHostShape {
  /** The lead's active tools. The child gets them without the sidekick tool itself. */
  readonly activeTools: Effect.Effect<readonly string[]>;
  /** Delivers a background report to the lead as a follow-up message that starts a turn. */
  readonly deliverReport: (report: { content: string; details: SidekickDetails }) => Effect.Effect<void>;
}

/** One `devin_sidekick` call. */
export interface HandoffRequest {
  /** Tool parameters as Pi passed them. */
  params: unknown;
  /** The lead's model. Only the Devin Fusion model may hand off. */
  model: { provider?: string; api?: string; id: string } | undefined;
  cwd: string;
  sessionId: string;
  /** The lead session is saved to a file; the child then keeps its own session file. */
  isSessionSaved: boolean;
  signal: AbortSignal | undefined;
  /** Progress while a blocking call waits for the report. */
  onProgress?: (text: string, details: SidekickDetails) => void;
}

export interface HandoffResult { content: { type: "text"; text: string }[]; details: SidekickDetails }

export interface SidekicksShape {
  /**
   * Starts or steers the session's handoff. By default waits for the report; with `block: false`, or when user input arrives
   * while waiting, the report moves to the background and is delivered once.
   */
  readonly handoff: (request: HandoffRequest) => Effect.Effect<HandoffResult, DevinFailure>;
  /** User input moves a waiting handoff to the background. Input sent by extensions does not count. */
  readonly userInput: (source: string) => Effect.Effect<void>;
  /** Stops the sidekicks of other lead sessions. */
  readonly sessionStarted: (sessionId: string) => Effect.Effect<void>;
  /** Stops every sidekick. */
  readonly reset: Effect.Effect<void>;
}
