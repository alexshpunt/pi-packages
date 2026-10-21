import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
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
      expect(state.id).toMatch(/^[a-z]+-[a-z]+$/);
      expect(state.cascadeId).not.toBe(state.trajectoryId);
      state.messages.push(userMessage("persisted"));
      state.ownerHash = "owner";
      expect(takeStep(state)).toBe(0);
      await saveSession(state);
      await expect(lockSession(state.id, false)).rejects.toThrow(/in use/);
      expect((await stat(join(directory, "sessions", state.id + ".json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "sessions"))).mode & 0o777).toBe(0o700);
    } finally { await release(); }
    const resumed = await openSession("ignored-new-default", state.id);
    try {
      expect(resumed.state).toStrictEqual(state);
      expect(takeStep(resumed.state)).toBe(1);
      await saveSession(resumed.state);
    } finally { await resumed.release(); }
    expect((await loadSession(state.id)).nextStepIndex).toBe(2);
    await expect(loadSession("../credentials")).rejects.toThrow(/Invalid session ID/);
    const ids = await Promise.all([installationId(), installationId()]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(await installationId());
    expect((await stat(join(directory, "installation-id"))).mode & 0o777).toBe(0o600);
  } finally {
    if (previous === undefined) delete process.env.DEVIN_POC_STATE_DIR; else process.env.DEVIN_POC_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
