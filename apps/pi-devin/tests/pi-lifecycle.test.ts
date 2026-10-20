import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import devinExtension from "../index.ts";
import { DEVIN_STATE_ENTRY, DevinLifecycle, ModelBudgetError, modelCallLimit, type DevinSessionState } from "../src/pi/lifecycle.ts";
import type { DevinProvider } from "../src/pi/provider.ts";

const owner = "a".repeat(64);
const bind = (manager: SessionManager) => ({ getSessionId: () => manager.getSessionId(), getBranch: () => manager.getBranch(), append: (data: DevinSessionState) => { manager.appendCustomEntry(DEVIN_STATE_ENTRY, data); } });

test("auto-compaction, the main request and host retries share the execution/budget; only settled allows a new budget", async () => {
  const manager = SessionManager.inMemory(), life = new DevinLifecycle(); life.attach(bind(manager));
  life.beforeCompaction("threshold");
  const compact = await life.acquire(owner); compact.consume(); assert.equal(compact.isAuxiliary, true); compact.release();
  life.afterCompaction("threshold"); life.begin("agent"); life.agentStarted();
  const first = await life.acquire(owner); first.consume(); assert.equal(first.isRecovery, false); first.release();
  life.agentStarted(); // The low-level agent_start fires again on retry.
  const retry = await life.acquire(owner); retry.consume(); assert.equal(retry.isRecovery, true); retry.release();
  assert.deepEqual([compact.stepIndex, first.stepIndex, retry.stepIndex], [0, 1, 2]);
  assert.equal(compact.executionId, retry.executionId); assert.equal(first.executionId, retry.executionId);
  assert.equal(life.snapshot().execution!.used, 3);
  life.finish();
  const restored = new DevinLifecycle(); restored.attach(bind(manager)); restored.begin("agent"); restored.agentStarted();
  const next = await restored.acquire(owner); next.consume(); next.release();
  assert.equal(next.stepIndex, 3); assert.notEqual(next.executionId, first.executionId);
  assert.equal(next.cascadeId, first.cascadeId); assert.equal(next.trajectoryId, first.trajectoryId);
  const entries = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === DEVIN_STATE_ENTRY);
  const firstEntry = entries[0];
  if (firstEntry.type !== "custom") assert.fail("custom entry expected");
  assert.equal((firstEntry.data as DevinSessionState).execution!.used, 0); // Older entries are not corrupted through shared references.
  restored.finish();
});

test("cancelling while queued never sends the next request ahead of the earlier one", async () => {
  const life = new DevinLifecycle(); life.begin("agent");
  const first = await life.acquire(owner); let closed = 0;
  first.addCleanup(() => { closed++; }); first.consume();
  const cancelled = new AbortController(); const second = life.acquire(owner, cancelled.signal);
  cancelled.abort(); await assert.rejects(second, { name: "AbortError" });
  let acquired = false;
  const third = life.acquire(owner).then((lease) => { acquired = true; return lease; });
  await Promise.resolve(); assert.equal(acquired, false);
  first.release(); first.release();
  const final = await third; final.consume(); final.release();
  assert.equal(closed, 1); assert.equal(final.stepIndex, 1); assert.equal(life.snapshot().execution!.used, 2);
  life.finish();
});

test("an unfinished 8-call budget is not reset by shutdown/reload", async () => {
  const manager = SessionManager.inMemory(), life = new DevinLifecycle(); life.attach(bind(manager)); life.begin("agent");
  for (let i = 0; i < 8; i++) { const lease = await life.acquire(owner); lease.consume(); lease.release(); }
  life.shutdown(); life.shutdown();
  const resumed = new DevinLifecycle(); resumed.attach(bind(manager)); resumed.begin("agent");
  await assert.rejects(resumed.acquire(owner), ModelBudgetError);
  assert.equal(resumed.snapshot().execution!.used, 8);
  resumed.finish(); resumed.begin("agent");
  const next = await resumed.acquire(owner); next.consume(); next.release();
  assert.equal(resumed.snapshot().execution!.used, 1);
});

test("tree uses a new trajectory and another session/fork does not share the previous cascade", async () => {
  const manager = SessionManager.inMemory(), life = new DevinLifecycle(); life.attach(bind(manager));
  const lease = await life.acquire(owner); lease.consume(); lease.release(); life.finish();
  const entries = manager.getBranch(), previous = life.snapshot();
  manager.branch(entries[0].id); life.treeChanged();
  const branch = await life.acquire(owner); branch.consume(); branch.release();
  assert.equal(branch.cascadeId, previous.cascadeId); assert.notEqual(branch.trajectoryId, previous.trajectoryId); assert.equal(branch.stepIndex, 0);
  const fork = SessionManager.inMemory(); fork.appendCustomEntry(DEVIN_STATE_ENTRY, previous);
  const replacement = new DevinLifecycle(); replacement.attach(bind(fork));
  const fresh = await replacement.acquire(owner); fresh.consume(); fresh.release();
  assert.notEqual(fresh.cascadeId, previous.cascadeId); assert.notEqual(fresh.sessionId, previous.sessionId);
});

test("account changes and late writes are rejected, and unused runs of other providers create no entry", async () => {
  const manager = SessionManager.inMemory(), life = new DevinLifecycle(); life.attach(bind(manager));
  life.begin("agent"); life.agentStarted(); life.finish(); life.treeChanged();
  assert.equal(manager.getBranch().length, 0);
  const lease = await life.acquire(owner); lease.consume();
  await assert.rejects(life.acquire("b".repeat(64)), /different Devin account/);
  life.shutdown(); assert.throws(() => lease.consume(), { name: "AbortError" }); lease.release();
  const replacement = SessionManager.inMemory(); life.attach(bind(replacement));
  assert.throws(() => lease.consume(), { name: "AbortError" });
  assert.equal(replacement.getBranch().length, 0);
  const stored = JSON.stringify(manager.getBranch());
  for (const word of ["sessionToken", "fingerprint", "assignmentJwt", "messages"]) assert.equal(stored.includes(word), false);
});

test("a corrupt state is not silently replaced with a new budget", () => {
  const manager = SessionManager.inMemory(); manager.appendCustomEntry(DEVIN_STATE_ENTRY, { version: 99 });
  assert.throws(() => new DevinLifecycle().attach(bind(manager)), /unsupported version/);
});

test("the budget defaults to 8, the configurable maximum is 100, and the 101st send is rejected", async () => {
  assert.equal(new DevinLifecycle().maxModelCalls, 8);
  assert.throws(() => new DevinLifecycle(101), /between 1 and 100/);
  const lifecycle = new DevinLifecycle(100), lease = await lifecycle.acquire(owner);
  for (let i = 0; i < 100; i++) lease.consume();
  assert.throws(() => lease.consume(), ModelBudgetError);
  lease.release(); lifecycle.finish();
});

test("PI_DEVIN_MAX_MODEL_CALLS flows from the extension entry to the lifecycle budget and a bad value stops loading", () => {
  assert.equal(modelCallLimit(undefined), undefined); assert.equal(modelCallLimit(""), undefined);
  assert.deepEqual([modelCallLimit("1"), modelCallLimit("100")], [1, 100]);
  for (const value of ["0", "101", "8.5", "-1", " 8", "abc"]) assert.throws(() => modelCallLimit(value), /integer from 1 to 100/);
  const previous = process.env.PI_DEVIN_MAX_MODEL_CALLS;
  const providers: DevinProvider[] = [];
  const pi = { registerProvider: (provider: DevinProvider) => { providers.push(provider); }, registerTool: () => {}, registerCommand: () => {}, on: () => () => {},
    getActiveTools: () => [], setActiveTools: () => {} } as unknown as ExtensionAPI;
  try {
    process.env.PI_DEVIN_MAX_MODEL_CALLS = "40"; devinExtension(pi);
    delete process.env.PI_DEVIN_MAX_MODEL_CALLS; devinExtension(pi);
    assert.deepEqual(providers.map((provider) => provider.lifecycle.maxModelCalls), [40, 8]);
    process.env.PI_DEVIN_MAX_MODEL_CALLS = "500";
    assert.throws(() => devinExtension(pi), /integer from 1 to 100/);
    assert.equal(providers.length, 2);
  } finally {
    if (previous === undefined) delete process.env.PI_DEVIN_MAX_MODEL_CALLS; else process.env.PI_DEVIN_MAX_MODEL_CALLS = previous;
    for (const provider of providers) provider.shutdown();
  }
});
