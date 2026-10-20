import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
describe("one-shot live runner with a mocked network", () => {
  it.each(["", "search"])(
    "bounds each endpoint and stops after failure: %s",
    (failure) => {
      const temp = mkdtempSync(join(tmpdir(), "ollama-live-budget-"));
      const reportPath = join(temp, "report.json");
      const args = [
        "--import",
        "tsx",
        "--import",
        "./test/fixtures/live-transport.ts",
        "scripts/cli/live.ts",
        "--live-minimal",
        "--package-dir",
        root,
        "--report",
        reportPath,
      ];
      const env = {
        ...process.env,
        PI_CODING_AGENT_DIR: join(temp, "auth"),
        OLLAMA_API_KEY: "fixture",
        OLLAMA_API_BASE: "",
        PI_OFFLINE: "1",
        LIVE_FIXTURE_FAILURE: failure,
      };
      try {
        const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 20000 });
        expect(result.status, result.stderr).toBe(failure ? 1 : 0);
        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        expect(report.apiCallCounts).toEqual({
          chat: 1,
          web_search: 1,
          web_fetch: failure ? 0 : 1,
          publicMetadata: 1,
          balance: 1,
          blocked: 0,
        });
        expect(JSON.stringify(report)).not.toContain("Bearer");
        expect(JSON.stringify(report)).not.toContain("fixture body");
        const repeated = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 10000 });
        expect(repeated.status).toBe(1);
        expect(repeated.stdout).toContain(
          'MOCK_LIVE_COUNTS={"chat":0,"search":0,"fetch":0,"metadata":0,"balance":0,"unexpected":0}',
        );
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
    30000,
  );
});
