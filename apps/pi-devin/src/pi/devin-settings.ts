import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 1;

/** Display settings toggled by `/devin`. Both default to off and never change how models are used or requested. */
export interface DevinPreferences {
  /** Lists only the models that have a variant the catalog marks as recommended. */
  recommendedOnly: boolean;
  /** Shows quota and session usage in the TUI status line. */
  showUsageStatus: boolean;
}

export const DEFAULT_PREFERENCES: DevinPreferences = { recommendedOnly: false, showUsageStatus: false };

export interface DevinSettings {
  read(): DevinPreferences;
  write(preferences: DevinPreferences): void;
}

export function devinSettingsPath(agentDir: string): string {
  return join(agentDir, "pi-devin", "settings.json");
}

/** Default store so SDK callers and tests never write to the real agent directory. */
export function memoryDevinSettings(initial: Partial<DevinPreferences> = {}): DevinSettings {
  let current: DevinPreferences = { ...DEFAULT_PREFERENCES, ...initial };
  return { read: () => ({ ...current }), write: (preferences) => { current = { ...preferences }; } };
}

/** An unreadable or malformed file reads as the defaults and is not overwritten. Writes are replaced atomically within the same directory. */
export function fileDevinSettings(path: string): DevinSettings {
  return {
    read() {
      try {
        const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        if (value.schemaVersion === SCHEMA_VERSION && typeof value.recommendedOnly === "boolean" && typeof value.showUsageStatus === "boolean") {
          return { recommendedOnly: value.recommendedOnly, showUsageStatus: value.showUsageStatus };
        }
      } catch { /* A missing or corrupt file falls back to the defaults. */ }
      return { ...DEFAULT_PREFERENCES };
    },
    write(preferences) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...preferences }, null, 2) + "\n");
      renameSync(temporary, path);
    },
  };
}
