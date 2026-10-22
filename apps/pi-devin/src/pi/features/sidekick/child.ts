import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Deferred, Effect, Exit } from "effect";
import { toDevinError, type DevinError } from "../../../core/errors.ts";
import { launchArgs } from "./command.ts";
import type { Handoff, HandoffProgress, HandoffReport, SidekickLauncherShape, SidekickLaunch } from "./types.ts";

const STDERR_TAIL = 2048;
const RECENT_TOOLS = 5;
const KILL_GRACE_MS = 2000;

export interface SidekickChildOptions {
  launcher: SidekickLauncherShape;
  childEnv: Record<string, string>;
  onProgress?: () => void;
  /** Runs work that child process events start, in a fiber its owner tracks. */
  fork: (effect: Effect.Effect<void>) => void;
}

interface PendingHandoff {
  id: string;
  startedAt: number;
  toolCalls: number;
  recentTools: string[];
  lastError?: string;
  isAborted: boolean;
  done: Deferred.Deferred<HandoffReport>;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Sidekick child Pi RPC process bound to one lead session. Started on the first handoff; keeps its context for the rest of the session.
 * A handoff during a run adds instructions with `steer`; when the child run ends (`agent_settled`), the last assistant text is returned as the report.
 */
export class SidekickChild {
  readonly launch: SidekickLaunch;
  private readonly options: SidekickChildOptions;
  private child: ChildProcess | undefined;
  private pending: PendingHandoff | undefined;
  private stderrTail = "";
  private readonly waiting = new Map<string, Deferred.Deferred<string | undefined>>();

  constructor(launch: SidekickLaunch, options: SidekickChildOptions) {
    this.launch = launch;
    this.options = options;
  }

  isBusy(): boolean { return this.pending !== undefined; }
  isAlive(): boolean { return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null; }

  progress(): HandoffProgress | undefined {
    const current = this.pending;
    return current ? { toolCalls: current.toolCalls, recentTools: [...current.recentTools], elapsedMs: Date.now() - current.startedAt } : undefined;
  }

  /** Starts a handoff, or steers the running one. Fails only when the child cannot be started. */
  handoff(message: string): Effect.Effect<Handoff, DevinError> {
    return Effect.gen({ self: this }, function* () {
      const current = this.pending;
      if (current) {
        this.send({ type: "steer", message });
        return { id: current.id, done: current.done, isSteer: true };
      }
      if (!this.isAlive()) yield* this.start;
      const id = randomUUID();
      const done = Deferred.makeUnsafe<HandoffReport>();
      this.pending = { id, startedAt: Date.now(), toolCalls: 0, recentTools: [], isAborted: false, done };
      this.send({ id, type: "prompt", message });
      return { id, done, isSteer: false };
    });
  }

  get abort(): Effect.Effect<void> {
    return Effect.sync(() => {
      if (!this.pending) return;
      this.pending.isAborted = true;
      this.send({ type: "abort" });
    });
  }

  /** Stops the child: its handoff ends as aborted and every RPC wait is released. Termination continues in the background. */
  get close(): Effect.Effect<void> {
    return Effect.sync(() => this.closeChild());
  }

  private closeChild(): void {
    const child = this.child;
    this.child = undefined;
    if (this.pending) this.finish("aborted", "", "Stopped the sidekick process.");
    for (const waiter of this.waiting.values()) Deferred.doneUnsafe(waiter, Exit.succeed(undefined));
    this.waiting.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, KILL_GRACE_MS);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
    child.kill("SIGTERM");
  }

  private get start(): Effect.Effect<void, DevinError> {
    return Effect.gen({ self: this }, function* () {
      const { launcher } = this.options;
      const base = yield* launcher.resolveCommand;
      const args = [...base.args, ...launchArgs(this.launch, launcher.packageRoot)];
      const child = yield* Effect.try({
        try: () => launcher.spawn(base.command, args, {
          cwd: this.launch.cwd,
          env: { ...launcher.env, ...this.options.childEnv },
          stdio: ["pipe", "pipe", "pipe"],
        }),
        catch: toDevinError,
      });
      this.child = child;
      this.stderrTail = "";
      this.listen(child);
    });
  }

  private listen(child: ChildProcess): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      buffer += decoder.write(chunk);
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line) continue;
        let record: Record<string, unknown>;
        try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        this.handle(record);
        if (this.child !== child) return;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { if (this.child === child) this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL); });
    child.stdin?.on("error", (error) => this.fail(child, error.message));
    child.on("error", (error) => this.fail(child, error.message));
    child.on("close", () => this.fail(child, this.stderrTail.trim() || "The sidekick process exited."));
  }

  /** Transport errors settle the handoff and all RPC waits once, even if the failed child closes after its replacement starts. */
  private fail(child: ChildProcess | undefined, error: string): void {
    if (this.child !== child) return;
    this.finish(this.pending?.isAborted ? "aborted" : "error", "", error);
    this.closeChild();
  }

  private send(value: Record<string, unknown>): void {
    const child = this.child;
    try {
      if (!child?.stdin?.writable) throw new Error("Cannot write to the sidekick process.");
      child.stdin.write(JSON.stringify(value) + "\n");
    } catch (error) {
      this.fail(child, errorMessage(error));
    }
  }

  /** Sends the request at once; the returned wait is released with `undefined` when the child stops. */
  private request(type: string): Effect.Effect<string | undefined> {
    const id = randomUUID();
    const waiter = Deferred.makeUnsafe<string | undefined>();
    this.waiting.set(id, waiter);
    this.send({ id, type });
    return Deferred.await(waiter);
  }

  private handle(record: Record<string, unknown>): void {
    const current = this.pending;
    switch (record.type) {
      case "response": {
        const waiter = typeof record.id === "string" ? this.waiting.get(record.id) : undefined;
        if (waiter) {
          this.waiting.delete(record.id as string);
          const data = record.data as { text?: unknown } | undefined;
          Deferred.doneUnsafe(waiter, Exit.succeed(typeof data?.text === "string" ? data.text : undefined));
        } else if (current && record.command === "prompt" && record.success === false) {
          this.finish("error", "", String(record.error ?? "The sidekick did not receive the instructions."));
        }
        return;
      }
      case "extension_ui_request":
        // The sidekick never talks to the user. Dialogs that need an answer are returned as cancelled.
        if (["select", "confirm", "input", "editor"].includes(String(record.method))) {
          this.send({ type: "extension_ui_response", id: record.id, cancelled: true });
        }
        return;
      case "tool_execution_start":
        if (!current) return;
        current.toolCalls++;
        current.recentTools = [...current.recentTools, String(record.toolName ?? "tool")].slice(-RECENT_TOOLS);
        this.options.onProgress?.();
        return;
      case "message_end": {
        const message = record.message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
        if (current && message?.role === "assistant") {
          current.lastError = message.stopReason === "error" && typeof message.errorMessage === "string" ? message.errorMessage : undefined;
        }
        return;
      }
      case "agent_settled":
        if (current) this.options.fork(this.complete(current, record.aborted === true));
        return;
    }
  }

  private complete(current: PendingHandoff, isAborted: boolean): Effect.Effect<void> {
    return Effect.map(this.request("get_last_assistant_text"), (text) => {
      if (this.pending !== current) return;
      if (isAborted || current.isAborted) this.finish("aborted", text ?? "");
      else if (current.lastError) this.finish("error", text ?? "", current.lastError);
      else this.finish("completed", text ?? "");
    });
  }

  private finish(status: HandoffReport["status"], text: string, error?: string): void {
    const current = this.pending;
    if (!current) return;
    this.pending = undefined;
    Deferred.doneUnsafe(current.done, Exit.succeed({
      id: current.id, status, text, toolCalls: current.toolCalls, durationMs: Date.now() - current.startedAt, ...(error ? { error } : {}),
    }));
    this.options.onProgress?.();
  }
}
