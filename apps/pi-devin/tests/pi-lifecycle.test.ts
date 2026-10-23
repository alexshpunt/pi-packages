import { Effect } from "effect";
import { expect, test } from "vitest";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import devinExtension from "../index.ts";
import { ModelBudgetError } from "../src/core/errors.ts";
import { DevinLifecycle, modelCallLimit } from "../src/pi/features/runs/lifecycle.ts";
import { DEVIN_STATE_ENTRY } from "../src/pi/features/runs/state.ts";
import type { DevinSessionState } from "../src/pi/features/runs/types.ts";
import type { DevinProvider } from "../src/pi/adapters/pi/types.ts";
import { run, runSync } from "./helpers.ts";

const owner = "a".repeat(64);
const bind = (manager: SessionManager) => ({ getSessionId: () => manager.getSessionId(), getBranch: () => manager.getBranch(), append: (data: DevinSessionState) => { manager.appendCustomEntry(DEVIN_STATE_ENTRY, data); } });

test("auto-compaction, the main request and host retries share the execution/budget; only settled allows a new budget", async () => {
  const manager = SessionManager.inMemory(), life = runSync(DevinLifecycle.make()); runSync(life.attach(bind(manager)));
  runSync(life.beforeCompaction("threshold"));
  const compact = await run(life.acquire(owner)); runSync(compact.consume); expect(compact.isAuxiliary).toBe(true); runSync(compact.release);
  runSync(life.afterCompaction("threshold")); runSync(life.begin("agent")); runSync(life.agentStarted);
  const first = await run(life.acquire(owner)); runSync(first.consume); expect(first.isRecovery).toBe(false); runSync(first.release);
  runSync(life.agentStarted); // The low-level agent_start fires again on retry.
  const retry = await run(life.acquire(owner)); runSync(retry.consume); expect(retry.isRecovery).toBe(true); runSync(retry.release);
  expect([compact.stepIndex, first.stepIndex, retry.stepIndex]).toStrictEqual([0, 1, 2]);
  expect(compact.executionId).toBe(retry.executionId); expect(first.executionId).toBe(retry.executionId);
  expect(runSync(life.snapshot).execution!.used).toBe(3);
  runSync(life.finish);
  const restored = runSync(DevinLifecycle.make()); runSync(restored.attach(bind(manager))); runSync(restored.begin("agent")); runSync(restored.agentStarted);
  const next = await run(restored.acquire(owner)); runSync(next.consume); runSync(next.release);
  expect(next.stepIndex).toBe(3); expect(next.executionId).not.toBe(first.executionId);
  expect(next.cascadeId).toBe(first.cascadeId); expect(next.trajectoryId).toBe(first.trajectoryId);
  const entries = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === DEVIN_STATE_ENTRY);
  const firstEntry = entries[0];
  if (firstEntry.type !== "custom") expect.unreachable("custom entry expected");
  expect((firstEntry.data as DevinSessionState).execution!.used).toBe(0); // Older entries are not corrupted through shared references.
  runSync(restored.finish);
});

test("cancelling while queued never sends the next request ahead of the earlier one", async () => {
  const life = runSync(DevinLifecycle.make()); runSync(life.begin("agent"));
  const first = await run(life.acquire(owner)); let closed = 0;
  runSync(first.addCleanup(Effect.sync(() => { closed++; }))); runSync(first.consume);
  const cancelled = new AbortController(); const second = run(life.acquire(owner), cancelled.signal);
  cancelled.abort(); await expect(second).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  let acquired = false;
  const third = run(life.acquire(owner)).then((lease) => { acquired = true; return lease; });
  await Promise.resolve(); expect(acquired).toBe(false);
  runSync(first.release); runSync(first.release);
  const final = await third; runSync(final.consume); runSync(final.release);
  expect(closed).toBe(1); expect(final.stepIndex).toBe(1); expect(runSync(life.snapshot).execution!.used).toBe(2);
  runSync(life.finish);
});

test("an unfinished 8-call budget is not reset by shutdown/reload", async () => {
  const manager = SessionManager.inMemory(), life = runSync(DevinLifecycle.make()); runSync(life.attach(bind(manager))); runSync(life.begin("agent"));
  for (let i = 0; i < 8; i++) { const lease = await run(life.acquire(owner)); runSync(lease.consume); runSync(lease.release); }
  runSync(life.shutdown); runSync(life.shutdown);
  const resumed = runSync(DevinLifecycle.make()); runSync(resumed.attach(bind(manager))); runSync(resumed.begin("agent"));
  await expect(run(resumed.acquire(owner))).rejects.toThrow(ModelBudgetError);
  expect(runSync(resumed.snapshot).execution!.used).toBe(8);
  runSync(resumed.finish); runSync(resumed.begin("agent"));
  const next = await run(resumed.acquire(owner)); runSync(next.consume); runSync(next.release);
  expect(runSync(resumed.snapshot).execution!.used).toBe(1);
});

test("tree uses a new trajectory and another session/fork does not share the previous cascade", async () => {
  const manager = SessionManager.inMemory(), life = runSync(DevinLifecycle.make()); runSync(life.attach(bind(manager)));
  const lease = await run(life.acquire(owner)); runSync(lease.consume); runSync(lease.release); runSync(life.finish);
  const entries = manager.getBranch(), previous = runSync(life.snapshot);
  manager.branch(entries[0].id); runSync(life.treeChanged);
  const branch = await run(life.acquire(owner)); runSync(branch.consume); runSync(branch.release);
  expect(branch.cascadeId).toBe(previous.cascadeId); expect(branch.trajectoryId).not.toBe(previous.trajectoryId); expect(branch.stepIndex).toBe(0);
  const fork = SessionManager.inMemory(); fork.appendCustomEntry(DEVIN_STATE_ENTRY, previous);
  const replacement = runSync(DevinLifecycle.make()); runSync(replacement.attach(bind(fork)));
  const fresh = await run(replacement.acquire(owner)); runSync(fresh.consume); runSync(fresh.release);
  expect(fresh.cascadeId).not.toBe(previous.cascadeId); expect(fresh.sessionId).not.toBe(previous.sessionId);
});

test("account changes and late writes are rejected, and unused runs of other providers create no entry", async () => {
  const manager = SessionManager.inMemory(), life = runSync(DevinLifecycle.make()); runSync(life.attach(bind(manager)));
  runSync(life.begin("agent")); runSync(life.agentStarted); runSync(life.finish); runSync(life.treeChanged);
  expect(manager.getBranch().length).toBe(0);
  const lease = await run(life.acquire(owner)); runSync(lease.consume);
  await expect(run(life.acquire("b".repeat(64)))).rejects.toThrow(/different Devin account/);
  runSync(life.shutdown); expect(() => runSync(lease.consume)).toThrow(expect.objectContaining({ name: "AbortError" })); runSync(lease.release);
  const replacement = SessionManager.inMemory(); runSync(life.attach(bind(replacement)));
  expect(() => runSync(lease.consume)).toThrow(expect.objectContaining({ name: "AbortError" }));
  expect(replacement.getBranch().length).toBe(0);
  const stored = JSON.stringify(manager.getBranch());
  for (const word of ["sessionToken", "fingerprint", "assignmentJwt", "messages"]) expect(stored.includes(word)).toBe(false);
});

test("a corrupt state is not silently replaced with a new budget", () => {
  const manager = SessionManager.inMemory(); manager.appendCustomEntry(DEVIN_STATE_ENTRY, { version: 99 });
  expect(() => runSync(runSync(DevinLifecycle.make()).attach(bind(manager)))).toThrow(/unsupported version/);
});

test("the budget defaults to 8, the configurable maximum is 100, and the 101st send is rejected", async () => {
  expect(runSync(DevinLifecycle.make()).maxModelCalls).toBe(8);
  expect(() => runSync(DevinLifecycle.make(101))).toThrow(/between 1 and 100/);
  const lifecycle = runSync(DevinLifecycle.make(100)), lease = await run(lifecycle.acquire(owner));
  for (let i = 0; i < 100; i++) runSync(lease.consume);
  expect(() => runSync(lease.consume)).toThrow(ModelBudgetError);
  runSync(lease.release); runSync(lifecycle.finish);
});

test("PI_DEVIN_MAX_MODEL_CALLS flows from the extension entry to the lifecycle budget and a bad value stops loading", async () => {
  expect(runSync(modelCallLimit(undefined))).toBe(undefined); expect(runSync(modelCallLimit(""))).toBe(undefined);
  expect([runSync(modelCallLimit("1")), runSync(modelCallLimit("100"))]).toStrictEqual([1, 100]);
  for (const value of ["0", "101", "8.5", "-1", " 8", "abc"]) expect(() => runSync(modelCallLimit(value))).toThrow(/integer from 1 to 100/);
  const previous = process.env.PI_DEVIN_MAX_MODEL_CALLS;
  const providers: DevinProvider[] = [], devinCommands: ((args: string, ctx: never) => Promise<void>)[] = [], shutdowns: (() => void)[] = [];
  const pi = { registerProvider: (provider: DevinProvider) => { providers.push(provider); }, registerTool: () => {},
    registerCommand: (name: string, command: { handler: (args: string, ctx: never) => Promise<void> }) => { if (name === "devin") devinCommands.push(command.handler); },
    on: (name: string, handler: () => void) => { if (name === "session_shutdown") shutdowns.push(handler); return () => {}; },
    getActiveTools: () => [], setActiveTools: () => {} } as unknown as ExtensionAPI;
  // `/devin` reports the run budget, so the limit each instance received is visible without reaching into its services.
  const budgetLine = async (handler: (args: string, ctx: never) => Promise<void>) => {
    let text = "";
    await handler("", { mode: "rpc", sessionManager: { getBranch: () => [] }, ui: { notify: (message: string) => { text = message; } } } as never);
    return text.split("\n").find((line) => line.includes("model calls used"))?.trim();
  };
  try {
    process.env.PI_DEVIN_MAX_MODEL_CALLS = "40"; devinExtension(pi);
    delete process.env.PI_DEVIN_MAX_MODEL_CALLS; devinExtension(pi);
    expect(await Promise.all(devinCommands.map(budgetLine))).toStrictEqual(["▕░░░░░░░░░░▏ 0/40 model calls used", "▕░░░░░░░░░░▏ 0/8 model calls used"]);
    process.env.PI_DEVIN_MAX_MODEL_CALLS = "500";
    expect(() => devinExtension(pi)).toThrow(/integer from 1 to 100/);
    expect(providers.length).toBe(2);
  } finally {
    if (previous === undefined) delete process.env.PI_DEVIN_MAX_MODEL_CALLS; else process.env.PI_DEVIN_MAX_MODEL_CALLS = previous;
    for (const shutdown of shutdowns) shutdown();
  }
});
