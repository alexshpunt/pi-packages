import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FusionSelection } from "./models.ts";

const SCHEMA_VERSION = 1;

/** Global store for the lead and sidekick chosen with `/devin-fusion`. Every session uses the same value. */
export interface FusionSettings {
  read(): FusionSelection | undefined;
  write(selection: FusionSelection): void;
}

export function fusionSettingsPath(agentDir: string): string {
  return join(agentDir, "pi-devin", "fusion.json");
}

/** Default store so SDK callers that register the extension directly, and tests, never write to the real agent directory. */
export function memoryFusionSettings(initial?: FusionSelection): FusionSettings {
  let current = initial;
  return { read: () => current, write: (selection) => { current = { ...selection }; } };
}

/** An unreadable or malformed file reads as no saved value and is not overwritten. Writes are replaced atomically within the same directory. */
export function fileFusionSettings(path: string): FusionSettings {
  return {
    read() {
      try {
        const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        // Legacy IDs (`family:…`, `uid:…`) are read as is. `effectiveFusion` maps them to the current catalog's IDs.
        if (value.schemaVersion === SCHEMA_VERSION && typeof value.leadID === "string" && value.leadID.trim() !== ""
          && typeof value.sidekickID === "string" && value.sidekickID.trim() !== "") {
          return { leadID: value.leadID, sidekickID: value.sidekickID };
        }
      } catch { /* A missing or corrupt file falls back to the default pair. */ }
      return undefined;
    },
    write(selection) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ schemaVersion: SCHEMA_VERSION, leadID: selection.leadID, sidekickID: selection.sidekickID }, null, 2) + "\n");
      renameSync(temporary, path);
    },
  };
}
