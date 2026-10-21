import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import type { DevinProvider } from "../src/pi/provider.ts";
import { createSidekickTool, type SidekickDetails, type SidekickToolOptions } from "../src/pi/sidekick.ts";
import { SIDEKICK_REPORT_CHAR_LIMIT } from "../src/pi/sidekick-report.ts";

function fixture(onTools?: () => void) {
  const commands: Record<string, unknown>[] = [];
  const reports: { content: string; details: SidekickDetails }[] = [];
  const reportWaiters: (() => void)[] = [];
  let spawned = 0, lastText = "";
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null as string | null,
  });
  const send = (record: Record<string, unknown>) => child.stdout.write(JSON.stringify(record) + "\n");
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const command = JSON.parse(String(chunk)) as Record<string, unknown>;
    commands.push(command);
    if (command.type === "get_last_assistant_text") send({ type: "response", id: command.id, success: true, data: { text: lastText } });
    callback();
  } });
  const process = Object.assign(child, { stdin, kill: (signal: string) => { child.signalCode = signal; child.emit("close"); return true; } });
  const model = { id: "fusion", provider: "devin", api: "devin-connect", devin: { fusion: { leadID: "lead", sidekickID: "side" } } };
  const tool = createSidekickTool({
    getActiveTools: () => { onTools?.(); return []; },
    sendMessage: (message: { content: string; details: SidekickDetails }) => { reports.push(message); for (const resolve of reportWaiters.splice(0)) resolve(); },
  } as unknown as ExtensionAPI, {
    getModels: () => [model], getFusionChoices: () => ({ sidekicks: [{ id: "side", level: "medium" }] }),
  } as unknown as DevinProvider, {
    agentDir: () => "/unused-agent-dir",
    runtime: { resolveCommand: () => ({ command: "fake-pi", args: [] }),
      spawn: (() => { spawned++; return process as unknown as ChildProcess; }) as NonNullable<SidekickToolOptions["runtime"]>["spawn"] },
  });
  const ctx = { model, cwd: "/fixture", sessionManager: { getSessionId: () => "fixture", getSessionFile: () => undefined } } as unknown as ExtensionToolContext;
  return {
    tool, commands, reports, send, spawned: () => spawned,
    execute: (block = true, signal?: AbortSignal) => tool.definition.execute("fixture", { message: "work", block }, signal, undefined, ctx),
    nextReport: () => new Promise<void>((resolve) => reportWaiters.push(resolve)),
    settle: (text = "ONE REPORT", error?: string) => {
      lastText = text;
      send({ type: "message_end", message: { role: "assistant", stopReason: error ? "error" : "stop", ...(error ? { errorMessage: error } : {}) } });
      send({ type: "agent_settled", aborted: false });
    },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const block of [true, false]) {
  for (const when of ["entry", "handoff"]) {
    test(`devin_sidekick: cancellation at ${when} starts no child or handoff with block:${block}`, { timeout: 10_000 }, async () => {
      const controller = new AbortController();
      let toolsRead = 0;
      const f = fixture(() => { toolsRead++; if (when === "handoff") controller.abort(); });
      if (when === "entry") controller.abort();
      try {
        await expect(f.execute(block, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
        expect(f.commands).toStrictEqual([]);
        expect(f.spawned()).toBe(0);
        expect(toolsRead).toBe(when === "entry" ? 0 : 1);
        await flush();
        expect(f.reports).toStrictEqual([]);
      } finally { f.tool.reset(); }
    });
  }
}

test("devin_sidekick: a pre-cancelled steer leaves existing background work and its report intact", { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    await f.execute(false);
    await expect(f.execute(true, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(f.commands.map((command) => command.type)).toStrictEqual(["prompt"]);
    const delivered = f.nextReport();
    f.settle(); await delivered;
    expect(f.reports).toHaveLength(1);
    expect(f.reports[0].content).toContain("ONE REPORT");
  } finally { f.tool.reset(); }
});

for (const error of [undefined, "fixture failure"]) {
  test(`devin_sidekick: a blocking steer owns the ${error ? "failed" : "completed"} background report`, { timeout: 10_000 }, async () => {
    const f = fixture();
    try {
      await f.execute(false);
      const waiting = f.execute();
      f.settle("ONE REPORT", error);
      if (error) await expect(waiting).rejects.toThrow(`The sidekick task failed: ${error}\n\nONE REPORT`);
      else {
        const result = await waiting;
        expect(result.content).toStrictEqual([{ type: "text", text: "ONE REPORT" }]);
        expect(result.details).toMatchObject({ status: "completed", isSteer: true });
      }
      await flush();
      expect(f.reports).toStrictEqual([]);
      expect(f.commands.map((command) => command.type)).toStrictEqual(["prompt", "steer", "get_last_assistant_text"]);
    } finally { f.tool.reset(); }
  });
}

for (const settleFirst of [true, false]) {
  test(`devin_sidekick: user input returns blocking report ownership to background when completion is ${settleFirst ? "first" : "last"}`, { timeout: 10_000 }, async () => {
    const f = fixture();
    try {
      await f.execute(false);
      const waiting = f.execute();
      const delivered = f.nextReport();
      if (settleFirst) f.settle();
      f.tool.onInput("rpc");
      if (!settleFirst) f.settle();
      expect((await waiting).details).toMatchObject({ status: "background" });
      await delivered; await flush();
      expect(f.reports).toHaveLength(1);
      expect(f.reports[0].content).toContain("ONE REPORT");
    } finally { f.tool.reset(); }
  });
}

test("devin_sidekick: cancelling a blocking steer suppresses the previously scheduled background report", { timeout: 10_000 }, async () => {
  const f = fixture(), controller = new AbortController();
  try {
    await f.execute(false);
    const waiting = f.execute(true, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("Cancelled the sidekick task.");
    expect(f.commands.at(-1)?.type).toBe("abort");
    f.settle(); await flush();
    expect(f.reports).toStrictEqual([]);
  } finally { f.tool.reset(); }
});

test("devin_sidekick: completed background handoffs deliver once each without retaining their IDs in delivery sets", { timeout: 10_000 }, async () => {
  const sets: Set<unknown>[] = [], NativeSet = globalThis.Set;
  // Inspect the factory's strong sets without keeping any handoff promise alive or relying on GC timing.
  class TrackedSet<T> extends NativeSet<T> {
    constructor(values?: Iterable<T> | null) { super(values); sets.push(this); }
  }
  let f: ReturnType<typeof fixture>;
  try { globalThis.Set = TrackedSet; f = fixture(); }
  finally { globalThis.Set = NativeSet; }
  const ids: string[] = [];
  try {
    for (let index = 0; index < 30; index++) {
      const first = await f.execute(false), steer = await f.execute(false);
      const id = (first.details as SidekickDetails).handoffId;
      ids.push(id);
      expect((steer.details as SidekickDetails).handoffId).toBe(id);
      const delivered = f.nextReport();
      f.settle(`report ${index}`); await delivered;
      expect(f.reports).toHaveLength(index + 1);
      expect(f.reports[index].content).toContain(`report ${index}`);
    }
    expect(new Set(f.reports.map((report) => report.details.handoffId)).size).toBe(30);
    expect(sets.flatMap((set) => ids.filter((id) => set.has(id)))).toStrictEqual([]);
    expect(f.spawned()).toBe(1);
    f.tool.reset(); await flush();
    expect(f.reports).toHaveLength(30);
  } finally { f.tool.reset(); }
});

for (const block of [true, false]) {
  for (const source of ["prompt", "assistant"]) {
    test(`devin_sidekick: the entire oversized ${source} error is bounded and preserved with block:${block}`, { timeout: 10_000 }, async () => {
      const f = fixture(), error = `ERROR-HEAD ${"E".repeat(600_000)} ERROR-TAIL`;
      const body = source === "assistant" ? "REPORT-BODY" : "";
      let path: string | undefined;
      try {
        const result = f.execute(block);
        if (!block) await result;
        const delivered = !block ? f.nextReport() : undefined;
        if (source === "prompt") f.send({ type: "response", command: "prompt", success: false, error });
        else f.settle(body, error);
        let text: string;
        if (block) {
          const failure = await result.then(() => { throw new Error("Expected tool failure"); }, (error: Error) => error);
          text = failure.message;
          path = /Full report: (.+)\]$/.exec(text)?.[1];
        } else {
          await delivered;
          text = f.reports[0].content;
          path = f.reports[0].details.fullReportPath;
        }
        expect(text.length).toBeLessThanOrEqual(SIDEKICK_REPORT_CHAR_LIMIT);
        expect(text).toContain("The sidekick task failed: ERROR-HEAD");
        expect(text).not.toContain("ERROR-TAIL");
        expect(path).toBeTruthy(); if (!path) throw new Error("Missing preserved report");
        const heading = block ? "" : `Sidekick report for background handoff ${f.reports[0].details.handoffId.slice(0, 8)}:\n\n`;
        expect(await readFile(path, "utf8")).toBe(`${heading}The sidekick task failed: ${error}${body ? `\n\n${body}` : ""}`);
      } finally {
        f.tool.reset();
        if (path) await rm(dirname(path), { recursive: true, force: true });
      }
    });
  }
}
