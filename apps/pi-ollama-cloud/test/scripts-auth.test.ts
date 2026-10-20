import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authFeature } from "../scripts/cli/auth.ts";
import { chatResponse, withMockFetch } from "../scripts/cli/mock-transport.ts";
import { readStoredOllamaCloudKey, resolveOllamaCloudApiKey } from "../scripts/ollama-cloud-auth.ts";
import { completeOllamaChat } from "../src/pi/chat.ts";

describe("Ollama Cloud script credentials", () => {
  let authDir: string;
  let previousApiKey: string | undefined;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-ollama-cloud-auth-"));
    previousApiKey = process.env.OLLAMA_API_KEY;
  });

  afterEach(() => {
    if (previousApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = previousApiKey;
    rmSync(authDir, { recursive: true, force: true });
  });

  function writeAuth(data: unknown): string {
    const authPath = join(authDir, "auth.json");
    writeFileSync(authPath, JSON.stringify(data));
    return authPath;
  }

  it("reads an ollama-cloud API-key credential", () => {
    const authPath = writeAuth({ "ollama-cloud": { type: "api_key", key: "stored-key" } });
    expect(readStoredOllamaCloudKey(authPath)).toBe("stored-key");
  });

  it("ignores malformed JSON and non-API-key credentials", () => {
    const authPath = join(authDir, "auth.json");
    writeFileSync(authPath, "{");
    expect(readStoredOllamaCloudKey(authPath)).toBeUndefined();

    expect(readStoredOllamaCloudKey(writeAuth({ "ollama-cloud": { type: "oauth", key: "not-an-api-key" } }))).toBe(
      undefined,
    );
  });

  it("prefers the stored credential over the environment variable", async () => {
    process.env.OLLAMA_API_KEY = "environment-key";
    const authPath = writeAuth({ "ollama-cloud": { type: "api_key", key: "stored-key" } });
    expect(await resolveOllamaCloudApiKey(authPath)).toEqual({ apiKey: "stored-key", source: "auth.json" });
  });

  it("falls back to the environment variable when no stored key exists", async () => {
    process.env.OLLAMA_API_KEY = "environment-key";
    const authPath = writeAuth({});
    expect(await resolveOllamaCloudApiKey(authPath)).toEqual({ apiKey: "environment-key", source: "OLLAMA_API_KEY" });
  });

  it("runs the offline reference, command, priority and cancellation checks", async () => {
    await authFeature.verify({
      check: async (_name, run) => {
        await run();
      },
    });
  });

  it("uses the resolved stored reference through the default chat consumer", async () => {
    writeAuth({
      "ollama-cloud": { type: "api_key", key: "$TEST_OLLAMA_KEY", env: { TEST_OLLAMA_KEY: "fixture-consumer" } },
    });
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = authDir;
    const controller = new AbortController();
    try {
      let calls = 0;
      await withMockFetch(
        async (url, init) => {
          if (String(url).endsWith("/api/show")) return Response.json({ capabilities: ["tools"] });
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-consumer");
          calls += 1;
          return chatResponse();
        },
        async () => {
          expect((await completeOllamaChat("fixture", controller.signal)).answer).toBe("2");
        },
      );
      expect(calls).toBe(1);
    } finally {
      controller.abort();
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });

  it.each([
    ["smoke-web-tools.ts", [], 0],
    ["generate-limits.ts", ["fixture"], 1],
  ] as const)(
    "passes evaluated credentials to the actual %s script without live requests",
    (script, args, exitCode) => {
      writeAuth({
        "ollama-cloud": { type: "api_key", key: "$TEST_OLLAMA_KEY", env: { TEST_OLLAMA_KEY: "fixture-consumer" } },
      });
      const packageRoot = fileURLToPath(new URL("../", import.meta.url));
      const generatedPath = join(packageRoot, "src/generated/limits.generated.ts");
      const before = readFileSync(generatedPath);
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--import", "./test/fixtures/auth-transport.ts", `scripts/${script}`, ...args],
        {
          cwd: packageRoot,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: authDir,
            PI_OFFLINE: "1",
            OLLAMA_API_KEY: "fixture-fallback",
            OLLAMA_API_BASE: "",
          },
          encoding: "utf8",
          timeout: 15000,
        },
      );
      expect(result.status, result.stderr).toBe(exitCode);
      expect(result.stdout).toContain("fixture-auth-match=true");
      expect(result.stdout).not.toContain("fixture-auth-match=false");
      expect(result.stdout + result.stderr).not.toContain("fixture-consumer");
      expect(readFileSync(generatedPath)).toEqual(before);
    },
  );
});
