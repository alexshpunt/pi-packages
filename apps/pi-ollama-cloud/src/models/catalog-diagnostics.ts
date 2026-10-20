import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "./types.ts";

export interface CatalogDiagnostics {
  schemaVersion: 1;
  policyVersion: 1;
  source: "generated" | "stored" | "live";
  status: "restored" | "success" | "partial" | "failure" | "empty";
  lastAttemptAtMs?: number;
  lastSuccessAtMs?: number;
  nextRetryAtMs?: number;
  snapshotCheckedAtMs?: number;
  nativeThinkingIds: string[];
  failures: { id?: string; reason: string }[];
  persistence?: "saved" | "failed" | "unchanged";
}
export interface CatalogDiagnosticsStore {
  read(): CatalogDiagnostics | undefined;
  write(state: CatalogDiagnostics): boolean;
}

/** Only retry/provenance diagnostics live here. Pi's ModelsStore remains the sole catalog store. */
export function createCatalogDiagnosticsStore(path: string): CatalogDiagnosticsStore {
  return {
    read() {
      try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (
          !isRecord(value) ||
          value.schemaVersion !== 1 ||
          value.policyVersion !== 1 ||
          !["generated", "stored", "live"].includes(String(value.source)) ||
          !["restored", "success", "partial", "failure", "empty"].includes(String(value.status)) ||
          !Array.isArray(value.nativeThinkingIds) ||
          !value.nativeThinkingIds.every((id) => typeof id === "string") ||
          !Array.isArray(value.failures) ||
          !value.failures.every(
            (failure) =>
              isRecord(failure) &&
              typeof failure.reason === "string" &&
              (failure.id === undefined || typeof failure.id === "string"),
          )
        )
          return undefined;
        for (const name of ["lastAttemptAtMs", "lastSuccessAtMs", "nextRetryAtMs", "snapshotCheckedAtMs"]) {
          if (
            value[name] !== undefined &&
            (typeof value[name] !== "number" || !Number.isFinite(value[name]) || value[name] < 0)
          )
            return undefined;
        }
        return value as unknown as CatalogDiagnostics;
      } catch {
        return undefined;
      }
    },
    write(state) {
      const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
        renameSync(temporary, path);
        return true;
      } catch {
        return false;
      } finally {
        try {
          rmSync(temporary, { force: true });
        } catch {
          /* Best-effort diagnostic cleanup. */
        }
      }
    },
  };
}
