import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { Deferred, Effect } from "effect";
import { expect, test } from "vitest";
import { SidekickChild, type SidekickChildOptions } from "../src/pi/features/sidekick/child.ts";
import type { Handoff, SidekickLauncherShape } from "../src/pi/features/sidekick/types.ts";
import { run, runSync } from "./helpers.ts";

/** Keeps close separate from kill so old-child events can race with a replacement. */
class RpcChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: Record<string, unknown>[] = [];
  readonly kills: string[] = [];
  exitCode: number | null = null;
  signalCode: string | null = null;
  failWrite: string | undefined;
  readonly stdin = new Writable({ write: (chunk, _encoding, callback) => {
    const command = JSON.parse(String(chunk)) as Record<string, unknown>;
    this.commands.push(command);
    callback(command.type === this.failWrite ? Object.assign(new Error("fixture broken pipe"), { code: "EPIPE" }) : undefined);
  } });
  send(record: Record<string, unknown>) { this.stdout.write(JSON.stringify(record) + "\n"); }
  kill(signal: string) { this.kills.push(signal); this.signalCode = signal; return true; }
}

function fixture(failWrite?: string) {
  const children: RpcChild[] = [];
  const launcher: SidekickLauncherShape = {
    resolveCommand: Effect.succeed({ command: "fake-pi", args: [] }), env: {}, packageRoot: process.cwd(),
    spawn: (() => { const child = new RpcChild(); child.failWrite = failWrite; children.push(child); return child as unknown as ChildProcess; }) as SidekickLauncherShape["spawn"],
  };
  const options: SidekickChildOptions = { launcher, childEnv: {}, fork: (effect) => { Effect.runFork(effect); } };
  const runtime = new SidekickChild({ cwd: process.cwd(), modelID: "fixture", tools: [], systemPrompt: "" }, options);
  return {
    runtime, children,
    handoff: (message: string) => runSync(runtime.handoff(message)),
    close: () => runSync(runtime.close),
    dispose: () => { runSync(runtime.close); for (const child of children) child.emit("close"); },
  };
}

const reportOf = (handoff: Handoff) => run(Deferred.await(handoff.done));

for (const command of ["prompt", "steer", "get_last_assistant_text"]) {
  test(`SidekickChild: asynchronous stdin EPIPE during ${command} fails the handoff once and releases RPC waiters`, { timeout: 10_000 }, async () => {
    const f = fixture(command);
    try {
      const handoff = f.handoff("work");
      const child = f.children[0];
      let settlements = 0;
      void reportOf(handoff).then(() => { settlements++; });
      if (command === "steer") expect(f.handoff("more").done).toBe(handoff.done);
      if (command === "get_last_assistant_text") child.send({ type: "agent_settled", aborted: false });
      const report = await reportOf(handoff);
      expect([report.status, report.error]).toStrictEqual(["error", "fixture broken pipe"]);
      expect(child.kills).toStrictEqual(["SIGTERM"]);
      expect(f.runtime.isBusy()).toBe(false);
      expect(f.runtime.isAlive()).toBe(false);
      // These are internal transport waiters, not a public API: assert their release without waiting for close.
      expect((f.runtime as unknown as { waiting: Map<string, unknown> }).waiting.size).toBe(0);
      child.stdin.emit("error", new Error("late EPIPE"));
      child.emit("error", new Error("late child error"));
      child.emit("close");
      f.close();
      await Promise.resolve();
      expect(settlements).toBe(1);
      expect(child.kills).toStrictEqual(["SIGTERM"]);
    } finally { f.dispose(); }
  });
}

test("SidekickChild: synchronous steer write failure returns the shared failed handoff and stops the child", { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    const handoff = f.handoff("work"), child = f.children[0];
    child.stdin.write = () => { throw new Error("sync write failure"); };
    expect(f.handoff("more").done).toBe(handoff.done);
    expect(await reportOf(handoff)).toMatchObject({ status: "error", error: "sync write failure" });
    expect(child.kills).toStrictEqual(["SIGTERM"]);
  } finally { f.dispose(); }
});

test("SidekickChild: failed-child stdout, errors and delayed close cannot settle a replacement handoff or its text request", { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    const first = f.handoff("first"), old = f.children[0];
    old.stdin.emit("error", new Error("broken pipe"));
    expect(await reportOf(first)).toMatchObject({ status: "error" });
    const second = f.handoff("second"), child = f.children[1];
    child.send({ type: "agent_settled", aborted: false });
    const request = child.commands.at(-1)!;
    expect(request.type).toBe("get_last_assistant_text");
    old.send({ type: "response", id: request.id, success: true, data: { text: "stale text" } });
    old.send({ type: "response", command: "prompt", success: false, error: "stale failure" });
    old.stdin.emit("error", new Error("late pipe error"));
    old.emit("error", new Error("late process error"));
    old.emit("close");
    await Promise.resolve();
    expect(f.runtime.isBusy()).toBe(true);
    expect(child.kills).toStrictEqual([]);
    child.send({ type: "response", id: request.id, success: true, data: { text: "fresh report" } });
    expect(await reportOf(second)).toMatchObject({ status: "completed", text: "fresh report" });
    expect(old.kills).toStrictEqual(["SIGTERM"]);
  } finally { f.dispose(); }
});

test("SidekickChild: close releases an outstanding text request before the child exits", { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    const handoff = f.handoff("work"), child = f.children[0];
    child.send({ type: "agent_settled", aborted: false });
    expect((f.runtime as unknown as { waiting: Map<string, unknown> }).waiting.size).toBe(1);
    f.close();
    expect(await reportOf(handoff)).toMatchObject({ status: "aborted" });
    expect((f.runtime as unknown as { waiting: Map<string, unknown> }).waiting.size).toBe(0);
    expect(child.kills).toStrictEqual(["SIGTERM"]);
  } finally { f.dispose(); }
});

test("SidekickChild: a stdin error during abort keeps the handoff cancelled", { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    const handoff = f.handoff("work"), child = f.children[0];
    child.failWrite = "abort";
    runSync(f.runtime.abort);
    expect(await reportOf(handoff)).toMatchObject({ status: "aborted", error: "fixture broken pipe" });
    expect(child.kills).toStrictEqual(["SIGTERM"]);
  } finally { f.dispose(); }
});
