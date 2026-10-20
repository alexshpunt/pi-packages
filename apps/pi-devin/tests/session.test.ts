import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { userMessage } from "../src/core/inference/chat.ts";
import { installationId } from "../src/cli/initialization.ts";
import { loadSession, lockSession, openSession, saveSession, takeStep } from "../src/cli/session-store.ts";

test("session atomic save, resume, step continuity, duplicate locks and private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devin-session-"));
  const previous = process.env.DEVIN_POC_STATE_DIR;
  process.env.DEVIN_POC_STATE_DIR = directory;
  try {
    const { state, release } = await openSession("swe-2-medium");
    try {
      assert.match(state.id, /^[a-z]+-[a-z]+$/);
      assert.notEqual(state.cascadeId, state.trajectoryId);
      state.messages.push(userMessage("persisted"));
      state.ownerHash = "owner";
      assert.equal(takeStep(state), 0);
      await saveSession(state);
      await assert.rejects(lockSession(state.id, false), /in use/);
      assert.equal((await stat(join(directory, "sessions", state.id + ".json"))).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, "sessions"))).mode & 0o777, 0o700);
    } finally { await release(); }
    const resumed = await openSession("ignored-new-default", state.id);
    try {
      assert.deepEqual(resumed.state, state);
      assert.equal(takeStep(resumed.state), 1);
      await saveSession(resumed.state);
    } finally { await resumed.release(); }
    assert.equal((await loadSession(state.id)).nextStepIndex, 2);
    await assert.rejects(loadSession("../credentials"), /Invalid session ID/);
    const ids = await Promise.all([installationId(), installationId()]);
    assert.equal(ids[0], ids[1]);
    assert.equal(ids[0], await installationId());
    assert.equal((await stat(join(directory, "installation-id"))).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.DEVIN_POC_STATE_DIR; else process.env.DEVIN_POC_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
