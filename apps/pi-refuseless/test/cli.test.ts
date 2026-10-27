import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { MOCK_CATALOG } from "../scripts/mock-refuseless.ts";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

function cli(...args: string[]) {
  const env = { ...process.env };
  delete env.REFUSELESS_API_KEY;
  const result = spawnSync(process.execPath, ["scripts/cli.ts", ...args], { cwd: PACKAGE_DIR, encoding: "utf8", env });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("models --mock shows the catalog as Pi registers it, then each entry as reported", () => {
  const { code, stdout } = cli("models", "--mock");
  expect(code).toBe(0);
  expect(stdout).toMatch(/glm-5\.3-abliterated\s+1048576\s+131072\s+low, high, max\s+low\n/);
  expect(stdout).toMatch(/deepseek-v4\.1-flash-fast\s+1048576\s+131072\s+off, low, high, max\s+low\n/);
  expect(stdout).toMatch(/deepseek-v4\.1-flash-free\s+524288\s+131072\s+low, high, max\s+low\n/);
  const reported = stdout
    .split("Catalog entries as reported:\n")[1]!
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(reported).toStrictEqual(MOCK_CATALOG);
});

test("models without a key and unknown input exit with usage errors", () => {
  const missingKey = cli("models");
  expect(missingKey.code).toBe(2);
  expect(missingKey.stderr).toContain("No key. Set REFUSELESS_API_KEY");
  for (const args of [
    ["nope"],
    ["catalog"],
    ["models", "--bogus"],
    ["models", "--", "-p"],
    ["models", "--dir", "x", "--mock"],
    ["live"],
    ["live", "--model", "glm-5.3-abliterated", "--turns", "0"],
    // No key in the environment, so live stops before starting Pi or sending a request.
    ["live", "--model", "glm-5.3-abliterated"],
  ]) {
    const result = cli(...args);
    expect(result.code, args.join(" ")).toBe(2);
    expect(result.stderr).toContain("--help");
  }
  expect(cli("--help").code).toBe(0);
});
