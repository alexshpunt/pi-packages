import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generatedFeature } from "../scripts/cli/generated.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const files = ["catalog.generated.ts", "limits.generated.ts"];
const hashes = (root: string) =>
  Object.fromEntries(
    files.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(root, "src/generated", file)))
        .digest("hex"),
    ]),
  );
function prepare(root: string) {
  cpSync(join(packageRoot, "src"), join(root, "src"), { recursive: true });
  copyFileSync(join(packageRoot, "package.json"), join(root, "package.json"));
  mkdirSync(join(root, "test", "fixtures"), { recursive: true });
  copyFileSync(
    join(packageRoot, "test", "fixtures", "inspect-generated.ts"),
    join(root, "test", "fixtures", "inspect-generated.ts"),
  );
}
function run(script: string, outputDir: string, mode: string, extra: string[] = [], shouldOverrideOutputDir = true) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./test/fixtures/generation-transport.ts",
      `scripts/${script}`,
      ...extra,
      ...(shouldOverrideOutputDir ? ["--output-dir", join(outputDir, "src/generated")] : []),
    ],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(outputDir, "agent"),
        OLLAMA_API_KEY: "fixture",
        OLLAMA_API_BASE: "",
        PI_OFFLINE: "1",
        OLLAMA_GENERATION_FIXTURE: mode,
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
}
function inspect(root: string) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", join(root, "test", "fixtures", "inspect-generated.ts")],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(root, "agent"),
        OLLAMA_API_KEY: "",
        OLLAMA_API_BASE: "",
        PI_OFFLINE: "1",
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("generated runtime consumer: pass");
}

describe("shared generation transaction", () => {
  it("preserves complete output on failures and verifies the candidate before publication", async () => {
    await generatedFeature.verify({
      check: async (_name, run) => {
        await run();
      },
    });
  });

  it.each(["generate-models.ts", "generate-pricing.ts", "generate-reasoning.ts"])(
    "connects %s to one validated snapshot and the runtime generated sources",
    (script) => {
      const temp = mkdtempSync(join(tmpdir(), "ollama-generation-consumer-"));
      const before = hashes(packageRoot);
      try {
        prepare(temp);
        const result = run(script, temp, "success");
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          'fixture-counts={"catalog":1,"details":2,"pricing":1,"reasoning":1,"probe":0,"unexpected":0}',
        );
        inspect(temp);
        expect(hashes(packageRoot)).toEqual(before);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
    30000,
  );

  it.each([
    "partial",
    "all-failed",
    "empty",
    "invalid-pricing",
    "invalid-reasoning",
    "write-failure",
    "rename-failure",
  ])(
    "preserves the whole generated output set for actual script failure: %s",
    (mode) => {
      const temp = mkdtempSync(join(tmpdir(), "ollama-generation-failure-"));
      try {
        prepare(temp);
        const before = hashes(temp);
        const result = run("generate-models.ts", temp, mode);
        expect(result.status, result.stderr).toBe(1);
        expect(hashes(temp)).toEqual(before);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
    30000,
  );

  it("keeps the canonical snapshot old or complete when the actual script is killed around rename", () => {
    const temp = mkdtempSync(join(tmpdir(), "ollama-generation-crash-"));
    try {
      prepare(temp);
      const before = hashes(temp);
      const prepared = run("generate-models.ts", temp, "crash-before");
      expect(prepared.signal).toBe("SIGKILL");
      expect(hashes(temp)).toEqual(before);
      const committed = run("generate-models.ts", temp, "crash-after");
      expect(committed.signal).toBe("SIGKILL");
      inspect(temp);
      expect(hashes(temp)["limits.generated.ts"]).toBe(before["limits.generated.ts"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 30000);

  it("supports dry-run and preserves limits through the real failed probe entrypoint", () => {
    const temp = mkdtempSync(join(tmpdir(), "ollama-generation-options-"));
    try {
      prepare(temp);
      const before = hashes(temp);
      const sourceBefore = hashes(packageRoot);
      const dryRun = run("generate-models.ts", temp, "success", ["--dry-run"], false);
      expect(dryRun.status, dryRun.stderr).toBe(0);
      expect(dryRun.stdout).toContain(join(packageRoot, "src/generated/catalog.generated.ts"));
      expect(hashes(temp)).toEqual(before);
      const limits = run("generate-limits.ts", temp, "success", ["fixture-a"]);
      expect(limits.status, limits.stderr).toBe(1);
      expect(limits.stdout).toContain('"probe":1');
      expect(hashes(temp)).toEqual(before);
      expect(hashes(packageRoot)).toEqual(sourceBefore);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 30000);

  it("imports all script entrypoints without requests, credential reads or writes", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./test/fixtures/import-guard.ts",
        "--input-type=module",
        "--eval",
        [
          'import "./scripts/generate-models.ts";',
          'import "./scripts/generate-pricing.ts";',
          'import "./scripts/generate-reasoning.ts";',
          'import "./scripts/generate-limits.ts";',
        ].join("\n"),
      ],
      {
        cwd: packageRoot,
        env: { ...process.env, OLLAMA_API_KEY: "", OLLAMA_API_BASE: "", PI_OFFLINE: "1" },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });
});
