import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const STDERR_TAIL = 2048;
const RECENT_TOOLS = 5;
const KILL_GRACE_MS = 2000;

/** This package root. Passed to the child Pi with `-e` so it uses the same extension copy as the lead. Pi loads a path only once. */
export const PACKAGE_ROOT = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

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
export interface Handoff { id: string; done: Promise<HandoffReport>; isSteer: boolean }

export interface SidekickRuntimeOptions {
  /** Command that runs Pi. Defaults to the same Node and Pi CLI as the lead. */
  resolveCommand?: () => SidekickCommand;
  spawn?: typeof nodeSpawn;
  env?: NodeJS.ProcessEnv;
  childEnv: Record<string, string>;
  packageRoot?: string;
  onProgress?: () => void;
}

function piPackageRoot(start: string): string | undefined {
  let directory = dirname(start);
  while (directory !== dirname(directory)) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      try { if ((JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name === PI_PACKAGE) return directory; } catch { /* try the next parent */ }
    }
    directory = dirname(directory);
  }
  return undefined;
}

const EXTENSION_FLAGS = new Set(["-e", "--extension"]);
const EXTENSION_SWITCHES = new Set(["--no-extensions", "-ne", "--no-mcp"]);

/**
 * Passes only the extension selection from the lead CLI arguments to the child, so tools from extensions loaded only with `-e` work for the sidekick too.
 * Local paths become absolute paths from the lead's working directory. Source specifiers such as `builtin:` and `npm:` stay as they are.
 */
export function extensionArgs(argv: readonly string[], cwd: string): string[] {
  const forwarded: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (EXTENSION_SWITCHES.has(value)) forwarded.push(value);
    else if (EXTENSION_FLAGS.has(value) && index + 1 < argv.length) {
      const target = argv[++index];
      forwarded.push("-e", /^[a-z][a-z0-9+.-]*:/i.test(target) || isAbsolute(target) ? target : resolve(cwd, target));
    }
  }
  return forwarded;
}

/**
 * Starts the child with the same Node, exec options and Pi CLI as the lead Pi. The running CLI is preferred so extension selection arguments carry over;
 * when Pi is embedded through the SDK, the installed Pi package's bin is used. Inspect options are not passed, to avoid port conflicts.
 */
export function resolvePiCommand(): SidekickCommand {
  const candidates: { path: string; isRunningCLI: boolean }[] = [];
  try { if (process.argv[1]) candidates.push({ path: realpathSync(process.argv[1]), isRunningCLI: true }); } catch { /* missing path */ }
  try { candidates.push({ path: fileURLToPath(import.meta.resolve(PI_PACKAGE)), isRunningCLI: false }); } catch { /* cannot resolve */ }
  for (const candidate of candidates) {
    const root = piPackageRoot(candidate.path);
    if (!root) continue;
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
    if (bin && existsSync(join(root, bin))) {
      const execArgv = process.execArgv.filter((value) => !/^--(inspect|debug)/.test(value));
      const forwarded = candidate.isRunningCLI ? extensionArgs(process.argv.slice(2), process.cwd()) : [];
      return { command: process.execPath, args: [...execArgv, join(root, bin), ...forwarded] };
    }
  }
  throw new Error("Could not find a Pi CLI to run the sidekick.");
}

export function launchArgs(launch: SidekickLaunch, packageRoot: string): string[] {
  return [
    "--mode", "rpc",
    ...(launch.sessionFile ? ["--session", launch.sessionFile] : ["--no-session"]),
    "--model", `devin/${launch.modelID}`,
    ...(launch.thinking ? ["--thinking", launch.thinking] : []),
    "--append-system-prompt", launch.systemPrompt,
    "-e", packageRoot,
    ...(launch.tools.length ? ["--tools", launch.tools.join(",")] : ["--no-tools"]),
  ];
}

interface PendingHandoff {
  id: string;
  startedAt: number;
  toolCalls: number;
  recentTools: string[];
  lastError?: string;
  isAborted: boolean;
  resolve(report: HandoffReport): void;
  done: Promise<HandoffReport>;
}

/**
 * Sidekick child Pi RPC process bound to one lead session. Started on the first handoff; keeps its context for the rest of the session.
 * A handoff during a run adds instructions with `steer`; when the child run ends (`agent_settled`), the last assistant text is returned as the report.
 */
export class SidekickRuntime {
  readonly launch: SidekickLaunch;
  private readonly options: SidekickRuntimeOptions;
  private child: ChildProcess | undefined;
  private pending: PendingHandoff | undefined;
  private stderrTail = "";
  private readonly waiting = new Map<string, (text: string | undefined) => void>();

  constructor(launch: SidekickLaunch, options: SidekickRuntimeOptions) {
    this.launch = launch;
    this.options = options;
  }

  isBusy(): boolean { return this.pending !== undefined; }
  isAlive(): boolean { return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null; }

  progress(): HandoffProgress | undefined {
    const current = this.pending;
    return current ? { toolCalls: current.toolCalls, recentTools: [...current.recentTools], elapsedMs: Date.now() - current.startedAt } : undefined;
  }

  handoff(message: string): Handoff {
    if (this.pending) {
      this.send({ type: "steer", message });
      return { id: this.pending.id, done: this.pending.done, isSteer: true };
    }
    if (!this.isAlive()) this.start();
    let resolve!: (report: HandoffReport) => void;
    const done = new Promise<HandoffReport>((settle) => { resolve = settle; });
    const id = randomUUID();
    this.pending = { id, startedAt: Date.now(), toolCalls: 0, recentTools: [], isAborted: false, resolve, done };
    try { this.send({ id, type: "prompt", message }); }
    catch (error) { this.finish("error", "", error instanceof Error ? error.message : String(error)); }
    return { id, done, isSteer: false };
  }

  abort(): void {
    if (!this.pending) return;
    this.pending.isAborted = true;
    try { this.send({ type: "abort" }); } catch { this.finish("aborted", ""); }
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    if (this.pending) this.finish("aborted", "", "Stopped the sidekick process.");
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    child.kill("SIGTERM");
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, KILL_GRACE_MS);
    timer.unref();
  }

  private start(): void {
    const base = (this.options.resolveCommand ?? resolvePiCommand)();
    const args = [...base.args, ...launchArgs(this.launch, this.options.packageRoot ?? PACKAGE_ROOT)];
    const child = (this.options.spawn ?? nodeSpawn)(base.command, args, {
      cwd: this.launch.cwd,
      env: { ...(this.options.env ?? process.env), ...this.options.childEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stderrTail = "";
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
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
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL); });
    child.on("error", (error) => { if (this.child === child) this.finish("error", "", error.message); });
    child.on("close", () => {
      if (this.child === child) this.child = undefined;
      for (const resolve of this.waiting.values()) resolve(undefined);
      this.waiting.clear();
      if (this.pending) this.finish("error", "", this.stderrTail.trim() || "The sidekick process exited.");
    });
  }

  private send(value: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) throw new Error("Cannot write to the sidekick process.");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  private request(type: string): Promise<string | undefined> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      try { this.send({ id, type }); } catch { this.waiting.delete(id); resolve(undefined); }
    });
  }

  private handle(record: Record<string, unknown>): void {
    const current = this.pending;
    switch (record.type) {
      case "response": {
        const waiter = typeof record.id === "string" ? this.waiting.get(record.id) : undefined;
        if (waiter) {
          this.waiting.delete(record.id as string);
          const data = record.data as { text?: unknown } | undefined;
          waiter(typeof data?.text === "string" ? data.text : undefined);
        } else if (current && record.command === "prompt" && record.success === false) {
          this.finish("error", "", String(record.error ?? "The sidekick did not receive the instructions."));
        }
        return;
      }
      case "extension_ui_request":
        // The sidekick never talks to the user. Dialogs that need an answer are returned as cancelled.
        if (["select", "confirm", "input", "editor"].includes(String(record.method))) {
          try { this.send({ type: "extension_ui_response", id: record.id, cancelled: true }); } catch { /* shutting down */ }
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
        if (current) void this.complete(current, record.aborted === true);
        return;
    }
  }

  private async complete(current: PendingHandoff, isAborted: boolean): Promise<void> {
    const text = await this.request("get_last_assistant_text");
    if (this.pending !== current) return;
    if (isAborted || current.isAborted) this.finish("aborted", text ?? "");
    else if (current.lastError) this.finish("error", text ?? "", current.lastError);
    else this.finish("completed", text ?? "");
  }

  private finish(status: HandoffReport["status"], text: string, error?: string): void {
    const current = this.pending;
    if (!current) return;
    this.pending = undefined;
    current.resolve({ id: current.id, status, text, toolCalls: current.toolCalls, durationMs: Date.now() - current.startedAt, ...(error ? { error } : {}) });
    this.options.onProgress?.();
  }
}
