import { Effect } from "effect";
import { expect, test } from "vitest";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import devinExtension from "../index.ts";
import { DevinLifecycle } from "../src/pi/features/runs/lifecycle.ts";
import { DEVIN_STATE_ENTRY } from "../src/pi/features/runs/state.ts";
import type { DevinSessionState } from "../src/pi/features/runs/types.ts";
import type { DevinProvider } from "../src/pi/adapters/pi/types.ts";
import { run, runSync } from "./helpers.ts";

const owner = "a".repeat(64);
const bind = (manager: SessionManager) => ({ getSessionId: () => manager.getSessionId(), getBranch: () => manager.getBranch(), append: (data: DevinSessionState) => { manager.appendCustomEntry(DEVIN_STATE_ENTRY, data); } });

test("auto-compaction, the main request and host retries share the execution; only settled starts a new one", async () => {
  const manager = SessionManager.inMemory(), life = runSync(DevinLifecycle.make); runSync(life.attach(bind(manager)));
  runSync(life.beforeCompaction("threshold"));
  const compact = await run(life.acquire(owner)); runSync(compact.assertAttempt); expect(compact.isAuxiliary).toBe(true); runSync(compact.release);
  runSync(life.afterCompaction("threshold")); runSync(life.begin("agent")); runSync(life.agentStarted);
  const first = await run(life.acquire(owner)); runSync(first.assertAttempt); expect(first.isRecovery).toBe(false); runSync(first.release);
  runSync(life.agentStarted); // The low-level agent_start fires again on retry.
  const retry = await run(life.acquire(owner)); runSync(retry.assertAttempt); expect(retry.isRecovery).toBe(true); runSync(retry.release);
  expect([compact.stepIndex, first.stepIndex, retry.stepIndex]).toStrictEqual([0, 1, 2]);
  expect(compact.executionId).toBe(retry.executionId); expect(first.executionId).toBe(retry.executionId);
  runSync(life.finish);
  const restored = runSync(DevinLifecycle.make); runSync(restored.attach(bind(manager))); runSync(restored.begin("agent")); runSync(restored.agentStarted);
  const next = await run(restored.acquire(owner)); runSync(next.assertAttempt); runSync(next.release);
  expect(next.stepIndex).toBe(3); expect(next.executionId).not.toBe(first.executionId);
  expect(next.cascadeId).toBe(first.cascadeId); expect(next.trajectoryId).toBe(first.trajectoryId);
  const entries = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === DEVIN_STATE_ENTRY);
  const firstEntry = entries[0];
  if (firstEntry.type !== "custom") expect.unreachable("custom entry expected");
  expect((firstEntry.data as DevinSessionState).nextStepIndex).toBe(1); // Older entries are not corrupted through shared references.
  runSync(restored.finish);
});

test("cancelling while queued never sends the next request ahead of the earlier one", async () => {
  const life = runSync(DevinLifecycle.make); runSync(life.begin("agent"));
  const first = await run(life.acquire(owner)); let closed = 0;
  runSync(first.addCleanup(Effect.sync(() => { closed++; }))); runSync(first.assertAttempt);
  const cancelled = new AbortController(); const second = run(life.acquire(owner), cancelled.signal);
  cancelled.abort(); await expect(second).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  let acquired = false;
  const third = run(life.acquire(owner)).then((lease) => { acquired = true; return lease; });
  await Promise.resolve(); expect(acquired).toBe(false);
  runSync(first.release); runSync(first.release);
  const final = await third; runSync(final.assertAttempt); runSync(final.release);
  expect(closed).toBe(1); expect(final.stepIndex).toBe(1);
  runSync(life.finish);
});

test("a run sends any number of requests, and an unfinished run resumes after shutdown/reload", async () => {
  const manager = SessionManager.inMemory(), life = runSync(DevinLifecycle.make); runSync(life.attach(bind(manager))); runSync(life.begin("agent"));
  const leases = [];
  for (let i = 0; i < 101; i++) { const lease = await run(life.acquire(owner)); runSync(lease.assertAttempt); runSync(lease.assertAttempt); runSync(lease.release); leases.push(lease); }
  runSync(life.shutdown); runSync(life.shutdown);
  const resumed = runSync(DevinLifecycle.make); runSync(resumed.attach(bind(manager))); runSync(resumed.begin("agent"));
  const next = await run(resumed.acquire(owner)); runSync(next.assertAttempt); runSync(next.release);
  expect(next.executionId).toBe(leases[0].executionId); expect(next.stepIndex).toBe(101);
  runSync(resumed.finish); runSync(resumed.begin("agent"));
  const fresh = await run(resumed.acquire(owner)); runSync(fresh.release);
  expect(fresh.executionId).not.toBe(next.executionId);
});

test("a state saved with the former request count still restores its unfinished run", async () => {
  const manager = SessionManager.inMemory(), executionId = "11111111-1111-4111-8111-111111111111";
  manager.appendCustomEntry(DEVIN_STATE_ENTRY, { version: 1, sessionId: manager.getSessionId(), ownerHash: owner, cascadeId: "22222222-2222-4222-8222-222222222222",
    trajectoryId: "33333333-3333-4333-8333-333333333333", nextStepIndex: 8, execution: { id: executionId, used: 8, settled: false } });
  const life = runSync(DevinLifecycle.make); runSync(life.attach(bind(manager))); runSync(life.begin("agent"));
  const lease = await run(life.acquire(owner)); runSync(lease.assertAttempt); runSync(lease.release);
  expect([lease.executionId, lease.stepIndex]).toStrictEqual([executionId, 8]);
  expect(runSync(life.snapshot).execution).toStrictEqual({ id: executionId, settled: false, kind: "agent" });
  runSync(life.finish);
});

test("tree uses a new trajectory and another session/fork does not share the previous cascade", async () => {
  const manager = SessionManager.inMemory(), life = runSync(DevinLifecycle.make); runSync(life.attach(bind(manager)));
  const lease = await run(life.acquire(owner)); runSync(lease.assertAttempt); runSync(lease.release); runSync(life.finish);
  const entries = manager.getBranch(), previous = runSync(life.snapshot);
  manager.branch(entries[0].id); runSync(life.treeChanged);
  const branch = await run(life.acquire(owner)); runSync(branch.assertAttempt); runSync(branch.release);
  expect(branch.cascadeId).toBe(previous.cascadeId); expect(branch.trajectoryId).not.toBe(previous.trajectoryId); expect(branch.stepIndex).toBe(0);
  const fork = SessionManager.inMemory(); fork.appendCustomEntry(DEVIN_STATE_ENTRY, previous);
  const replacement = runSync(DevinLifecycle.make); runSync(replacement.attach(bind(fork)));
  const fresh = await run(replacement.acquire(owner)); runSync(fresh.assertAttempt); runSync(fresh.release);
  expect(fresh.cascadeId).not.toBe(previous.cascadeId); expect(fresh.sessionId).not.toBe(previous.sessionId);
});

test("account changes and late writes are rejected, and unused runs of other providers create no entry", async () => {
  const manager = SessionManager.inMemory(), life = runSync(DevinLifecycle.make); runSync(life.attach(bind(manager)));
  runSync(life.begin("agent")); runSync(life.agentStarted); runSync(life.finish); runSync(life.treeChanged);
  expect(manager.getBranch().length).toBe(0);
  const lease = await run(life.acquire(owner)); runSync(lease.assertAttempt);
  await expect(run(life.acquire("b".repeat(64)))).rejects.toThrow(/different Devin account/);
  runSync(life.shutdown); expect(() => runSync(lease.assertAttempt)).toThrow(expect.objectContaining({ name: "AbortError" })); runSync(lease.release);
  const replacement = SessionManager.inMemory(); runSync(life.attach(bind(replacement)));
  expect(() => runSync(lease.assertAttempt)).toThrow(expect.objectContaining({ name: "AbortError" }));
  expect(replacement.getBranch().length).toBe(0);
  const stored = JSON.stringify(manager.getBranch());
  for (const word of ["sessionToken", "fingerprint", "assignmentJwt", "messages"]) expect(stored.includes(word)).toBe(false);
});

test("a corrupt state is not silently replaced with a fresh one", () => {
  const manager = SessionManager.inMemory(); manager.appendCustomEntry(DEVIN_STATE_ENTRY, { version: 99 });
  expect(() => runSync(runSync(DevinLifecycle.make).attach(bind(manager)))).toThrow(/unsupported version/);
});

test("PI_DEVIN_MAX_MODEL_CALLS no longer affects loading, and /devin shows no run budget", async () => {
  const previous = process.env.PI_DEVIN_MAX_MODEL_CALLS;
  const providers: DevinProvider[] = [], devinCommands: ((args: string, ctx: never) => Promise<void>)[] = [], shutdowns: (() => void)[] = [];
  const pi = { registerProvider: (provider: DevinProvider) => { providers.push(provider); }, registerTool: () => {},
    registerCommand: (name: string, command: { handler: (args: string, ctx: never) => Promise<void> }) => { if (name === "devin") devinCommands.push(command.handler); },
    on: (name: string, handler: () => void) => { if (name === "session_shutdown") shutdowns.push(handler); return () => {}; },
    getActiveTools: () => [], setActiveTools: () => {} } as unknown as ExtensionAPI;
  try {
    process.env.PI_DEVIN_MAX_MODEL_CALLS = "500"; devinExtension(pi);
    expect(providers.length).toBe(1);
    let text = "";
    await devinCommands[0]("", { mode: "rpc", sessionManager: { getBranch: () => [] }, ui: { notify: (message: string) => { text = message; } } } as never);
    expect(text).toMatch(/This session/); expect(text).not.toMatch(/budget|model calls/i);
  } finally {
    if (previous === undefined) delete process.env.PI_DEVIN_MAX_MODEL_CALLS; else process.env.PI_DEVIN_MAX_MODEL_CALLS = previous;
    for (const shutdown of shutdowns) shutdown();
  }
});
