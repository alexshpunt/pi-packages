import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createParityBudget, PARITY_MAX_TOKENS, PARITY_MODEL_ID } from "../scripts/lib/verification/parity-budget.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
describe("50-request parity budget", () => {
  it("records failures before dispatch and blocks retries, wrong origins, and excess calls", async () => {
    const observed: number[] = [];
    const budget = createParityBudget({
      apiKey: "fixture",
      record: () => {
        observed.push(budget.counts.chat);
      },
      fetch: async (_url, init) => {
        expect(init?.redirect).toBe("error");
        throw new Error("transport");
      },
    });
    const init = {
      method: "POST",
      headers: { Authorization: "Bearer fixture" },
      body: JSON.stringify({ model: PARITY_MODEL_ID, max_tokens: PARITY_MAX_TOKENS, stream: true }),
    };
    for (let i = 0; i < 50; i++) {
      budget.setCase(String(i));
      await expect(budget.fetch("https://ollama.com/v1/chat/completions", init)).rejects.toThrow("transport");
      expect(observed.at(-1)).toBe(i + 1);
    }
    await expect(budget.fetch("https://ollama.com/v1/chat/completions", init)).rejects.toThrow("budget");
    budget.setCase("extra");
    await expect(budget.fetch("https://ollama.com/v1/chat/completions", init)).rejects.toThrow("budget");
    await expect(budget.fetch("https://example.test/v1/chat/completions", init)).rejects.toThrow("budget");
    expect(budget.counts.chat).toBe(50);
    expect(budget.blocked).toBe(3);
  });

  it.each(["", "chat"])(
    "runs the same 50-case plan without live requests, failure=%s",
    (failure) => {
      const temp = mkdtempSync(join(tmpdir(), "ollama-parity-test-"));
      const reportPath = join(temp, "report.json");
      const args = [
        "--import",
        "tsx",
        "--import",
        "./test/fixtures/parity-transport.ts",
        "scripts/cli/parity-live.ts",
        "--live-50",
        "--package-dir",
        root,
        "--report",
        reportPath,
      ];
      const env = { ...process.env, OLLAMA_API_KEY: "fixture", PI_OFFLINE: "1", PARITY_FIXTURE_FAILURE: failure };
      try {
        const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 30000 });
        expect(result.status, result.stdout + result.stderr).toBe(failure ? 1 : 0);
        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        expect(report.counts.chat).toBe(failure ? 1 : 50);
        expect(report.counts.metadata).toBe(1);
        expect(report.status).toBe(failure ? "fail" : "pass");
        expect(report.blocked).toBe(0);
        if (!failure) {
          expect(report.observations.every((observation: { pass: boolean }) => observation.pass)).toBe(true);
          expect(report.toolChecks).toHaveLength(10);
          expect(report.counts.search).toBe(1);
          expect(report.counts.fetch).toBe(1);
        }
        expect(JSON.stringify(report)).not.toContain("Bearer");
        const repeat = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 10000 });
        expect(repeat.status).toBe(1);
        expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual(report);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
    40000,
  );
});
