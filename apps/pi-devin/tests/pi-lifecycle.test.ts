import { expect, test } from "vitest";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import devinExtension from "../index.ts";
import { DEVIN_STATE_ENTRY, DevinLifecycle, ModelBudgetError, modelCallLimit, type DevinSessionState } from "../src/pi/lifecycle.ts";
import type { DevinProvider } from "../src/pi/provider.ts";

const owner = "a".repeat(64);
const bind = (manager: SessionManager) => ({ getSessionId: () => manager.getSessionId(), getBranch: () => manager.getBranch(), append: (data: DevinSessionState) => { manager.appendCustomEntry(DEVIN_STATE_ENTRY, data); } });

test("auto-compaction, the main request and host retries share the execution/budget; only settled allows a new budget", async () => {
  const manager = SessionManager.inMemory(), life = new DevinLifecycle(); life.attach(bind(manager));
  life.beforeCompaction("threshold");
  const compact = await life.acquire(owner); compact.consume(); expect(compact.isAuxiliary).toBe(true); compact.release();
  life.afterCompaction("threshold"); life.begin("agent"); life.agentStarted();
  const first = await life.acquire(owner); first.consume(); expect(first.isRecovery).toBe(false); first.release();
  life.agentStarted(); // The low-level agent_start fires again on retry.
  const retry = await life.acquire(owner); retry.consume(); expect(retry.isRecovery).toBe(true); retry.release();
  expect([compact.stepIndex, first.stepIndex, retry.stepIndex]).toStrictEqual([0, 1, 2]);
  expect(compact.executionId).toBe(retry.executionId); expect(first.executionId).toBe(retry.executionId);
  expect(life.snapshot().execution!.used).toBe(3);
  life.finish();
  const restored = new DevinLifecycle(); restored.attach(bind(manager)); restored.begin("agent"); restored.agentStarted();
  const next = await restored.acquire(owner); next.consume(); next.release();
  expect(next.stepIndex).toBe(3); expect(next.executionId).not.toBe(first.executionId);
  expect(next.cascadeId).toBe(first.cascadeId); expect(next.trajectoryId).toBe(first.trajectoryId);
  const entries = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === DEVIN_STATE_ENTRY);
  const firstEntry = entries[0];
  if (firstEntry.type !== "custom") expect.unreachable("custom entry expected");
  expect((firstEntry.data as DevinSessionState).execution!.used).toBe(0); // Older entries are not corrupted through shared references.
  restored.finish();
});

test("cancelling while queued never sends the next request ahead of the earlier one", async () => {
  const life = new DevinLifecycle(); life.begin("agent");
  const first = await life.acquire(owner); let closed = 0;
  first.addCleanup(() => { closed++; }); first.consume();
  const cancelled = new AbortController(); const second = life.acquire(owner, cancelled.signal);
  cancelled.abort(); await expect(second).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  let acquired = false;
  const third = life.acquire(owner).then((lease) => { acquired = true; return lease; });
  await Promise.resolve(); expect(acquired).toBe(false);
  first.release(); first.release();
  const final = await third; final.consume(); final.release();
  expect(closed).toBe(1); expect(final.stepIndex).toBe(1); expect(life.snapshot().execution!.used).toBe(2);
  life.finish();
});

test("an unfinished 8-call budget is not reset by shutdown/reload", async () => {
  const manager = SessionManager.inMemory(), life = new DevinLifecycle(); life.attach(bind(manager)); life.begin("agent");
  for (let i = 0; i < 8; i++) { const lease = await life.acquire(owner); lease.consume(); lease.release(); }
  life.shutdown(); life.shutdown();
  const resumed = new DevinLifecycle(); resumed.attach(bind(manager)); resumed.begin("agent");
  await expect(resumed.acquire(owner)).rejects.toThrow(ModelBudgetError);
  expect(resumed.snapshot().execution!.used).toBe(8);
  resumed.finish(); resumed.begin("agent");
  const next = await resumed.acquire(owner); next.consume(); next.release();
  expect(resumed.snapshot().execution!.used).toBe(1);
});

test("tree uses a new trajectory and another session/fork does not share the previous cascade", async () => {
  const manager = SessionManager.inMemory(), life = new DevinLifecycle(); life.attach(bind(manager));
  const lease = await life.acquire(owner); lease.consume(); lease.release(); life.finish();
  const entries = manager.getBranch(), previous = life.snapshot();
  manager.branch(entries[0].id); life.treeChanged();
  const branch = await life.acquire(owner); branch.consume(); branch.release();
  expect(branch.cascadeId).toBe(previous.cascadeId); expect(branch.trajectoryId).not.toBe(previous.trajectoryId); expect(branch.stepIndex).toBe(0);
  const fork = SessionManager.inMemory(); fork.appendCustomEntry(DEVIN_STATE_ENTRY, previous);
  const replacement = new DevinLifecycle(); replacement.attach(bind(fork));
  const fresh = await replacement.acquire(owner); fresh.consume(); fresh.release();
  expect(fresh.cascadeId).not.toBe(previous.cascadeId); expect(fresh.sessionId).not.toBe(previous.sessionId);
});

test("account changes and late writes are rejected, and unused runs of other providers create no entry", async () => {
  const manager = SessionManager.inMemory(), life = new DevinLifecycle(); life.attach(bind(manager));
  life.begin("agent"); life.agentStarted(); life.finish(); life.treeChanged();
  expect(manager.getBranch().length).toBe(0);
  const lease = await life.acquire(owner); lease.consume();
  await expect(life.acquire("b".repeat(64))).rejects.toThrow(/different Devin account/);
  life.shutdown(); expect(() => lease.consume()).toThrow(expect.objectContaining({ name: "AbortError" })); lease.release();
  const replacement = SessionManager.inMemory(); life.attach(bind(replacement));
  expect(() => lease.consume()).toThrow(expect.objectContaining({ name: "AbortError" }));
  expect(replacement.getBranch().length).toBe(0);
  const stored = JSON.stringify(manager.getBranch());
  for (const word of ["sessionToken", "fingerprint", "assignmentJwt", "messages"]) expect(stored.includes(word)).toBe(false);
});

test("a corrupt state is not silently replaced with a new budget", () => {
  const manager = SessionManager.inMemory(); manager.appendCustomEntry(DEVIN_STATE_ENTRY, { version: 99 });
  expect(() => new DevinLifecycle().attach(bind(manager))).toThrow(/unsupported version/);
});

test("the budget defaults to 8, the configurable maximum is 100, and the 101st send is rejected", async () => {
  expect(new DevinLifecycle().maxModelCalls).toBe(8);
  expect(() => new DevinLifecycle(101)).toThrow(/between 1 and 100/);
  const lifecycle = new DevinLifecycle(100), lease = await lifecycle.acquire(owner);
  for (let i = 0; i < 100; i++) lease.consume();
  expect(() => lease.consume()).toThrow(ModelBudgetError);
  lease.release(); lifecycle.finish();
});

test("PI_DEVIN_MAX_MODEL_CALLS flows from the extension entry to the lifecycle budget and a bad value stops loading", () => {
  expect(modelCallLimit(undefined)).toBe(undefined); expect(modelCallLimit("")).toBe(undefined);
  expect([modelCallLimit("1"), modelCallLimit("100")]).toStrictEqual([1, 100]);
  for (const value of ["0", "101", "8.5", "-1", " 8", "abc"]) expect(() => modelCallLimit(value)).toThrow(/integer from 1 to 100/);
  const previous = process.env.PI_DEVIN_MAX_MODEL_CALLS;
  const providers: DevinProvider[] = [];
  const pi = { registerProvider: (provider: DevinProvider) => { providers.push(provider); }, registerTool: () => {}, registerCommand: () => {}, on: () => () => {},
    getActiveTools: () => [], setActiveTools: () => {} } as unknown as ExtensionAPI;
  try {
    process.env.PI_DEVIN_MAX_MODEL_CALLS = "40"; devinExtension(pi);
    delete process.env.PI_DEVIN_MAX_MODEL_CALLS; devinExtension(pi);
    expect(providers.map((provider) => provider.lifecycle.maxModelCalls)).toStrictEqual([40, 8]);
    process.env.PI_DEVIN_MAX_MODEL_CALLS = "500";
    expect(() => devinExtension(pi)).toThrow(/integer from 1 to 100/);
    expect(providers.length).toBe(2);
  } finally {
    if (previous === undefined) delete process.env.PI_DEVIN_MAX_MODEL_CALLS; else process.env.PI_DEVIN_MAX_MODEL_CALLS = previous;
    for (const provider of providers) provider.shutdown();
  }
});
