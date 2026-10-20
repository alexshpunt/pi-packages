import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DIAGNOSTICS } from "../scripts/cli/registry.ts";
import { runCLI } from "../scripts/cli/runner.ts";
import { type VerificationContext, verifyFeature } from "../scripts/cli/verification.ts";
import { assertRuntimeBoundary } from "../scripts/lib/verification/artifact.ts";

describe("diagnostic registry", () => {
  it("replaces an old successful report with a failed run instead of leaving stale evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ollama-report-"));
    const path = join(directory, "report.json");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(path, JSON.stringify({ status: "pass" }));
      const feature = {
        ...DIAGNOSTICS[0].feature(),
        verify: async ({ check }: VerificationContext) => {
          await check("intentional fixture", () => {
            throw new Error("fixture failure");
          });
        },
      };
      await expect(verifyFeature(feature, ["--offline", "--report", path])).rejects.toThrow("fixture failure");
      const report = JSON.parse(readFileSync(path, "utf8"));
      expect(report.status).toBe("fail");
      expect(report.checks[0].result).toBe("fail");
    } finally {
      errorLog.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("statically connects all feature IDs and keeps runtime dependencies declared", () => {
    expect(DIAGNOSTICS.map((item) => item.feature().id)).toEqual(DIAGNOSTICS.map((item) => item.id));
    expect(DIAGNOSTICS).toHaveLength(10);
    assertRuntimeBoundary();
  });
  it("runs a fixture diagnostic without leaking its SIGINT into the parent menu", async () => {
    const actions = ["diagnostics", "01-core-cli", "exit"];
    const before = process.exitCode;
    const listeners = process.listenerCount("SIGINT");
    await runCLI([], {
      select: async () => actions.shift() ?? "exit",
      input: async () => "",
      fetchModelIds: async () => [],
      runChat: async () => {},
      isTTY: true,
    });
    expect(actions).toEqual([]);
    expect(process.exitCode).toBe(before);
    expect(process.listenerCount("SIGINT")).toBe(listeners);
  }, 30000);
});
