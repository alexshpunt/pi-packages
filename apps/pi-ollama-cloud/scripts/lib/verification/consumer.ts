import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./artifact.ts";

export function verifyPackageConsumer(
  target: string,
  directory: string,
  profile: "enabled" | "soft-disabled" | "hard-disabled",
) {
  const agentDir = join(directory, "agent");
  const cwd = join(directory, "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("PI_OLLAMA_") || key === "OLLAMA_API_BASE" || key === "OLLAMA_API_KEY") delete env[key];
  Object.assign(env, {
    PI_CODING_AGENT_DIR: agentDir,
    VERIFY_WORK_DIR: cwd,
    PI_OFFLINE: "1",
    PI_OLLAMA_SEARCH_CACHE_PATH: join(directory, "cache.json"),
    OLLAMA_API_KEY: "",
    OLLAMA_API_BASE: "",
  });
  if (profile === "hard-disabled") env.PI_OLLAMA_WEB_TOOLS = "off";
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "test/fixtures/package-contract.ts", target, profile],
    {
      cwd: packageRoot,
      env,
      encoding: "utf8",
      timeout: 45000,
      killSignal: "SIGKILL",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, `Package consumer failed (${profile}): ${result.stderr}`);
  const output = result.stdout.split("\n").find((line) => line.startsWith("CONTRACT_RESULT="));
  assert.ok(output, "Package consumer produced no contract report");
  return JSON.parse(output.slice("CONTRACT_RESULT=".length)) as Record<string, unknown>;
}
