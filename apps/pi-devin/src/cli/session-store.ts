import { randomInt, randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { credentialPath } from "./credentials.ts";
import { MAX_STEP_INDEX } from "../core/inference/state.ts";
import { object, requiredString, type ChatMessage, type JsonObject } from "../core/types.ts";

const ADJECTIVES = "amber brisk calm clear cool crisp eager fair fresh gentle golden green happy kind lively lucid mild neat nimble quiet rapid sage silver smooth soft steady sunny swift tidy vivid warm wise".split(" ");
const NOUNS = "birch brook cedar cloud coral crane dawn elm fern field finch forest frost grove heron hill iris lake leaf maple meadow moon oak olive otter pine pond rain reed river star willow".split(" ");
const MAX_SESSION_BYTES = 16 * 1024 * 1024;

export interface SessionState {
  version: 1;
  id: string;
  cascadeId: string;
  trajectoryId: string;
  nextStepIndex: number;
  model: string;
  cwd: string;
  messages: ChatMessage[];
  title?: string;
  hasTitleAttempted?: boolean;
  ownerHash?: string;
}

export function createSession(model: string, cwd = process.cwd()): SessionState {
  return {
    version: 1, id: `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}`,
    cascadeId: randomUUID(), trajectoryId: randomUUID(), nextStepIndex: 0,
    model, cwd, messages: [],
  };
}

function sessionPath(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error("Invalid session ID.");
  return join(dirname(credentialPath()), "sessions", `${id}.json`);
}

export async function loadSession(id: string): Promise<SessionState> {
  const file = await open(sessionPath(id), "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SESSION_BYTES) throw new Error("Invalid session file size or format.");
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const part of file.createReadStream({ autoClose: false })) {
      bytes += part.length;
      if (bytes > MAX_SESSION_BYTES) throw new Error("The session file size limit was exceeded.");
      parts.push(part);
    }
    const value = object(JSON.parse(Buffer.concat(parts).toString("utf8")), "session");
    if (value.version !== 1 || value.id !== id || !Array.isArray(value.messages)) throw new Error("Invalid session file.");
    for (const key of ["cascadeId", "trajectoryId", "model", "cwd"]) requiredString(value[key], `session.${key}`);
    if (!Number.isSafeInteger(value.nextStepIndex) || Number(value.nextStepIndex) < 0 || Number(value.nextStepIndex) > MAX_STEP_INDEX) {
      throw new Error("Invalid session step.");
    }
    if (value.messages.length > 5000) throw new Error("The session message limit was exceeded.");
    for (const entry of value.messages) {
      const message = object(entry, "session message");
      if (!["CHAT_MESSAGE_SOURCE_USER", "CHAT_MESSAGE_SOURCE_SYSTEM", "CHAT_MESSAGE_SOURCE_TOOL"].includes(String(message.source)) || typeof message.prompt !== "string") {
        throw new Error("Invalid session message.");
      }
    }
    return value as unknown as SessionState;
  } finally { await file.close(); }
}

export async function saveSession(state: SessionState): Promise<void> {
  const path = sessionPath(state.id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const json = JSON.stringify(state) + "\n";
  if (Buffer.byteLength(json) > MAX_SESSION_BYTES) throw new Error("The session save size limit was exceeded.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, json, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function lockSession(id: string, isNew: boolean): Promise<() => Promise<void>> {
  const path = sessionPath(id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const lockPath = `${path}.lock`;
  const file = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw Object.assign(new Error("The session is in use or a lock file exists."), { code: "EEXIST" });
    throw error;
  });
  const owned = await file.stat();
  let hasReleased = false;
  const release = async () => {
    if (hasReleased) return;
    hasReleased = true;
    await file.close();
    let current;
    try { current = await stat(lockPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (current.ino !== owned.ino || current.dev !== owned.dev) throw new Error("The lock file owner changed, so it is not deleted automatically.");
    await rm(lockPath);
  };
  try {
    if (isNew) {
      try { await stat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return release; throw error; }
      throw Object.assign(new Error("The session ID already exists."), { code: "EEXIST" });
    }
    return release;
  } catch (error) { await release(); throw error; }
}

export async function openSession(model: string, resumeId?: string): Promise<{ state: SessionState; release: () => Promise<void> }> {
  if (resumeId) {
    const release = await lockSession(resumeId, false);
    try { return { state: await loadSession(resumeId), release }; }
    catch (error) { await release(); throw error; }
  }
  for (let attempt = 0; attempt < 64; attempt++) {
    const state = createSession(model);
    try { return { state, release: await lockSession(state.id, true) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  throw new Error("Could not create an available session name.");
}


export { takeStep } from "../core/inference/state.ts";
