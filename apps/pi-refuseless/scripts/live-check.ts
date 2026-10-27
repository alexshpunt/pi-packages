/**
 * Live check for `cli live`: the installed `pi`, with this package, holds a conversation of up to ten turns
 * with each given Refuseless model over the real service. Every model runs in its own temporary agent and
 * work directory, all models at once. The key reaches Pi only through REFUSELESS_API_KEY; nothing writes it
 * to disk. Requests spend credits.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Level = "off" | "low" | "high";

interface Turn {
  prompt: string;
  /** Thinking level to set before the turn. */
  level?: Level;
  /** Whether the turn must run the bash tool successfully. */
  usesBash?: boolean;
  /** The expected answer, checked against the reply and, when given, the work directory. */
  check: (reply: string, workDir: string) => boolean;
  expected: string;
}

const TURNS: readonly Turn[] = [
  {
    prompt: "Reply with exactly the word READY and nothing else.",
    check: (reply) => /\bREADY\b/.test(reply),
    expected: "READY",
  },
  {
    prompt: "Remember this code word for later in our conversation: AMBER-42. Reply with OK.",
    check: (reply) => /\bOK\b/i.test(reply),
    expected: "OK",
  },
  {
    prompt: "What is 17 multiplied by 23? Reply with only the number.",
    check: (reply) => /\b391\b/.test(reply),
    expected: "391",
  },
  {
    prompt: "Use the bash tool to run `cat notes.txt`, then tell me the number written in that file.",
    usesBash: true,
    check: (reply) => /4096/.test(reply),
    expected: "bash runs, reply has 4096",
  },
  {
    prompt:
      "Use the bash tool to create a file named result.txt that contains exactly the text pi-refuseless-ok. Then reply DONE.",
    usesBash: true,
    check: (reply, workDir) =>
      /DONE/i.test(reply) &&
      existsSync(join(workDir, "result.txt")) &&
      readFileSync(join(workDir, "result.txt"), "utf8").includes("pi-refuseless-ok"),
    expected: "bash runs, result.txt has pi-refuseless-ok, reply DONE",
  },
  {
    prompt: "In one sentence, explain why the sky looks blue.",
    level: "high",
    check: (reply) => /scatter|rayleigh|wavelength/i.test(reply),
    expected: "mentions scattering or wavelength",
  },
  {
    prompt: "List the three primary colors of light, separated by commas.",
    level: "low",
    check: (reply) => /red/i.test(reply) && /green/i.test(reply) && /blue/i.test(reply),
    expected: "red, green, blue",
  },
  {
    prompt: "What was the code word I asked you to remember earlier? Reply with only the code word.",
    check: (reply) => /AMBER-42/.test(reply),
    expected: "AMBER-42",
  },
  {
    prompt: "Translate 'good morning' into Korean. Reply with only the translation.",
    level: "off",
    check: (reply) => /[가-힣]/.test(reply),
    expected: "Korean text",
  },
  {
    prompt: "Summarize what we did in this conversation in one sentence.",
    check: (reply) => reply.trim().length > 0,
    expected: "a non-empty summary",
  },
];

export const MAX_TURNS = TURNS.length;

export interface TurnResult {
  turn: number;
  ok: boolean;
  problem?: string;
  seconds: number;
  thinkingLevel: string;
  stopReason: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingChars: number;
  bashRuns: number;
  reply: string;
}

export interface ModelResult {
  model: string;
  startingLevel: string;
  turns: TurnResult[];
  error?: string;
}

/** Pi in RPC mode: one JSON record per line on stdout, commands as JSON lines on stdin. */
class RpcPi {
  readonly events: any[] = [];
  private nextId = 0;
  private pending = "";
  private stderr = "";
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(bin, args, { cwd, env });
    this.child.stdout.on("data", (data) => {
      this.pending += data;
      for (let end = this.pending.indexOf("\n"); end !== -1; end = this.pending.indexOf("\n")) {
        const line = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + 1);
        try {
          this.events.push(JSON.parse(line));
        } catch {}
      }
    });
    this.child.stderr.on("data", (data) => {
      this.stderr = (this.stderr + data).slice(-2000);
    });
  }

  async waitFor(match: (event: any) => boolean, from: number, timeoutMs: number, label: string) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.slice(from).find(match);
      if (found) return found;
      if (this.child.exitCode !== null) throw new Error(`pi exited while waiting for ${label}: ${this.stderr.trim()}`);
      if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async send(command: Record<string, unknown>, timeoutMs = 30_000) {
    const id = `live-${this.nextId++}`;
    const from = this.events.length;
    this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    const response = await this.waitFor(
      (event) => event.type === "response" && event.id === id,
      from,
      timeoutMs,
      `${command.type}`,
    );
    if (!response.success) throw new Error(`${command.type} failed: ${response.error}`);
    return response.data;
  }

  async stop() {
    this.child.kill("SIGTERM");
    if (this.child.exitCode === null) await new Promise((resolve) => this.child.once("exit", resolve));
  }
}

const text = (message: any, type: "text" | "thinking") =>
  (message?.content ?? [])
    .filter((block: any) => block.type === type)
    .map((block: any) => (type === "text" ? block.text : block.thinking))
    .join("");

async function runModel(options: {
  bin: string;
  packageDir: string;
  isolation: string[];
  key: string;
  model: string;
  turns: number;
  root: string;
  onTurn: (model: string, result: TurnResult) => void;
}): Promise<ModelResult> {
  const { model } = options;
  const agentDir = join(options.root, model, "agent");
  const workDir = join(options.root, model, "work");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, "notes.txt"), "The answer is 4096.\n");
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, REFUSELESS_API_KEY: options.key };
  delete env.PI_OFFLINE;
  const pi = new RpcPi(options.bin, [...options.isolation, "-e", options.packageDir, "--mode", "rpc"], workDir, env);
  const result: ModelResult = { model, startingLevel: "", turns: [] };
  try {
    // RPC mode fetches the model list in the background after startup.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const { models } = await pi.send({ type: "get_available_models" });
      if (models.some((entry: any) => entry.provider === "refuseless" && entry.id === model)) break;
      if (Date.now() > deadline) throw new Error(`refuseless/${model} did not appear in the model list`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await pi.send({ type: "set_model", provider: "refuseless", modelId: model });
    result.startingLevel = (await pi.send({ type: "get_state" })).thinkingLevel;

    for (const [index, turn] of TURNS.slice(0, options.turns).entries()) {
      if (turn.level) await pi.send({ type: "set_thinking_level", level: turn.level });
      const thinkingLevel = (await pi.send({ type: "get_state" })).thinkingLevel;
      const from = pi.events.length;
      const started = Date.now();
      await pi.send({ type: "prompt", message: turn.prompt });
      await pi.waitFor((event) => event.type === "agent_settled", from, 300_000, `turn ${index + 1}`);
      const events = pi.events.slice(from);
      const assistant = events
        .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
        .map((event) => event.message);
      const last = assistant.at(-1);
      const reply = text(last, "text");
      const bashRuns = events.filter(
        (event) => event.type === "tool_execution_end" && event.toolName === "bash" && !event.isError,
      ).length;
      const problems = [
        !last && "no assistant message",
        last && last.stopReason !== "stop" && `stopReason ${last.stopReason}: ${last.errorMessage ?? ""}`.trim(),
        assistant.some(
          (message) =>
            message.provider !== "refuseless" ||
            message.model !== model ||
            (message.responseModel !== undefined && message.responseModel !== model),
        ) &&
          `a reply came from ${assistant
            .map((message) => `${message.provider}/${message.responseModel ?? message.model}`)
            .join(", ")}`,
        turn.usesBash && bashRuns === 0 && "bash did not run",
        last && last.stopReason === "stop" && !turn.check(reply, workDir) && `expected ${turn.expected}`,
      ].filter(Boolean) as string[];
      const turnResult: TurnResult = {
        turn: index + 1,
        ok: problems.length === 0,
        problem: problems.join("; ") || undefined,
        seconds: Math.round((Date.now() - started) / 100) / 10,
        thinkingLevel,
        stopReason: last?.stopReason ?? "-",
        provider: last?.provider ?? "-",
        model: last?.model ?? "-",
        inputTokens: assistant.reduce(
          (sum, message) => sum + (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0),
          0,
        ),
        outputTokens: assistant.reduce((sum, message) => sum + (message.usage?.output ?? 0), 0),
        thinkingChars: assistant.reduce((sum, message) => sum + text(message, "thinking").length, 0),
        bashRuns,
        reply: reply.replace(/\s+/g, " ").trim(),
      };
      result.turns.push(turnResult);
      options.onTurn(model, turnResult);
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    await pi.stop();
  }
  return result;
}

/** Runs the conversation with every model at once and writes the report; returns the results. */
export async function liveCheck(options: {
  bin: string;
  packageDir: string;
  isolation: string[];
  key: string;
  models: string[];
  turns: number;
  log: (line: string) => void;
}): Promise<{ results: ModelResult[]; reportPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-refuseless-live-"));
  try {
    const results = await Promise.all(
      options.models.map((model) =>
        runModel({
          ...options,
          model,
          root,
          onTurn: (name, turn) =>
            options.log(
              `${turn.ok ? "pass" : "FAIL"}  ${name} turn ${turn.turn} (${turn.seconds}s, thinking ${turn.thinkingLevel}` +
                `${turn.bashRuns ? `, bash ×${turn.bashRuns}` : ""})  ${turn.problem ?? turn.reply.slice(0, 70)}`,
            ),
        }),
      ),
    );
    const reportDir = await mkdtemp(join(tmpdir(), "pi-refuseless-live-report-"));
    const reportPath = join(reportDir, "live.json");
    await writeFile(reportPath, `${JSON.stringify({ when: new Date().toISOString(), results }, null, 2)}\n`);
    return { results, reportPath };
  } finally {
    // The agent directories hold session files with the conversation; nothing in them is needed afterwards.
    await rm(root, { recursive: true, force: true });
  }
}
