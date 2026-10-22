import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { takeStep } from "../src/cli/services/sessions.ts";
import { userMessage } from "../src/core/inference/request.ts";
import { sessionStore, stateFiles } from "./cli-helpers.ts";
import { run, runSync } from "./helpers.ts";

test("session atomic save, resume, step continuity, duplicate locks and private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devin-session-"));
  const previous = process.env.DEVIN_POC_STATE_DIR;
  process.env.DEVIN_POC_STATE_DIR = directory;
  try {
    const files = stateFiles(join(directory, "credentials.json")), sessions = sessionStore(join(directory, "credentials.json"));
    const { state, release } = await run(sessions.open("swe-2-medium"));
    try {
      expect(state.id).toMatch(/^[a-z]+-[a-z]+$/);
      expect(state.cascadeId).not.toBe(state.trajectoryId);
      state.messages.push(userMessage("persisted"));
      state.ownerHash = "owner";
      expect(runSync(takeStep(state))).toBe(0);
      await run(sessions.save(state));
      await expect(run(sessions.lock(state.id, false))).rejects.toThrow(/in use/);
      expect((await stat(join(directory, "sessions", state.id + ".json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "sessions"))).mode & 0o777).toBe(0o700);
    } finally { await run(release); }
    const resumed = await run(sessions.open("ignored-new-default", state.id));
    try {
      expect(resumed.state).toStrictEqual(state);
      expect(runSync(takeStep(resumed.state))).toBe(1);
      await run(sessions.save(resumed.state));
    } finally { await run(resumed.release); }
    expect((await run(sessions.load(state.id))).nextStepIndex).toBe(2);
    await expect(run(sessions.load("../credentials"))).rejects.toThrow(/Invalid session ID/);
    const ids = await Promise.all([run(files.installationId), run(files.installationId)]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(await run(files.installationId));
    expect((await stat(join(directory, "installation-id"))).mode & 0o777).toBe(0o600);
  } finally {
    if (previous === undefined) delete process.env.DEVIN_POC_STATE_DIR; else process.env.DEVIN_POC_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
