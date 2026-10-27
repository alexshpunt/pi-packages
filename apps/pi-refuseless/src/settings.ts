import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** What `/pi-refuseless` saves in `refuseless.json` in Pi's agent directory. */
export interface RefuselessSettings {
  /** False hides the available credits in the status line. */
  creditsStatus?: boolean;
}

export const settingsPath = () => join(getAgentDir(), "refuseless.json");

/** The JSON object in `path`, an empty object when the file does not exist. Throws when the file holds anything else. */
function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON; fix or remove it.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object; fix or remove it.`);
  }
  return parsed as Record<string, unknown>;
}

/** The saved settings. A missing or unreadable file, and values of the wrong type, give no settings. */
export function readSettings(): RefuselessSettings {
  let saved: Record<string, unknown>;
  try {
    saved = readObject(settingsPath());
  } catch {
    return {};
  }
  return typeof saved.creditsStatus === "boolean" ? { creditsStatus: saved.creditsStatus } : {};
}

/**
 * Merges `patch` into the settings file, keeping keys this version does not know, and replaces the file in one
 * rename. Throws, without writing, when the file is not a JSON object.
 */
export function saveSettings(patch: RefuselessSettings) {
  const path = settingsPath();
  const next = { ...readObject(path), ...patch };
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode });
    renameSync(temporary, path);
  } catch (error) {
    throw new Error(`Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}
