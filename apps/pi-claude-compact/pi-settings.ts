// Pi's own compaction stays enabled as the safety net (disabling it also disables overflow recovery).
// These helpers read Pi's trigger and move it up to Claude Code's blocking limit. Pi exposes no setter
// for compaction.modelOverrides, so the global settings.json is edited under the same proper-lockfile
// lock Pi's settings storage takes; the running session keeps its in-memory settings until Pi restarts.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, DEFAULT_COMPACTION_SETTINGS, getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

export interface PiCompactionView {
  enabled: boolean;
  reserveTokens: number;
  modelOverrides: Record<string, { reserveTokens?: number }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads Pi's effective compaction settings from `pi.getSettings()` output. */
export function piCompactionView(settings: unknown): PiCompactionView {
  const compaction = isRecord(settings) && isRecord(settings.compaction) ? settings.compaction : {};
  const overrides: Record<string, { reserveTokens?: number }> = {};
  if (isRecord(compaction.modelOverrides)) {
    for (const [key, value] of Object.entries(compaction.modelOverrides)) {
      if (isRecord(value) && typeof value.reserveTokens === "number")
        overrides[key] = { reserveTokens: value.reserveTokens };
    }
  }
  return {
    enabled: typeof compaction.enabled === "boolean" ? compaction.enabled : DEFAULT_COMPACTION_SETTINGS.enabled,
    reserveTokens:
      typeof compaction.reserveTokens === "number"
        ? compaction.reserveTokens
        : DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    modelOverrides: overrides,
  };
}

export function piReserveFor(view: PiCompactionView, key: string): number {
  return view.modelOverrides[key]?.reserveTokens ?? view.reserveTokens;
}

export function piSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  if (!isRecord(parsed)) throw new Error(`${path}: root is not an object`);
  return parsed;
}

/** Model keys whose reserveTokens the project settings override (they win over the global file). */
export function projectReserveOverrides(cwd: string): Set<string> {
  const path = projectSettingsPath(cwd);
  if (!existsSync(path)) return new Set();
  try {
    const settings = readJsonObject(path);
    const compaction = isRecord(settings.compaction) ? settings.compaction : {};
    const overrides = isRecord(compaction.modelOverrides) ? compaction.modelOverrides : {};
    return new Set(
      Object.entries(overrides)
        .filter(([, value]) => isRecord(value) && value.reserveTokens !== undefined)
        .map(([key]) => key),
    );
  } catch {
    return new Set();
  }
}

/** Pi's FileSettingsStorage.acquireLockSyncWithRetry: 10 attempts, 20ms apart, on ELOCKED only. */
function acquireLock(path: string): () => void {
  for (let attempt = 1; ; attempt++) {
    try {
      return lockfile.lockSync(path, { realpath: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === 10) throw error;
      const start = Date.now();
      while (Date.now() - start < 20) {
        // Synchronous wait, as Pi does, so the read-modify-write stays inside one lock.
      }
    }
  }
}

/** Sets compaction.modelOverrides[key].reserveTokens in the global settings.json, keeping everything else. */
export function writePiReserveOverrides(updates: Record<string, number>): void {
  const path = piSettingsPath();
  if (!existsSync(path)) writeFileSync(path, "{}\n", "utf8");
  const release = acquireLock(path);
  try {
    const settings = readJsonObject(path);
    const compaction = isRecord(settings.compaction) ? settings.compaction : {};
    const overrides = isRecord(compaction.modelOverrides) ? compaction.modelOverrides : {};
    for (const [key, reserveTokens] of Object.entries(updates)) {
      const existing = isRecord(overrides[key]) ? overrides[key] : {};
      overrides[key] = { ...existing, reserveTokens };
    }
    settings.compaction = { ...compaction, modelOverrides: overrides };
    writeFileSync(path, JSON.stringify(settings, null, 2), "utf8");
  } finally {
    release();
  }
}
