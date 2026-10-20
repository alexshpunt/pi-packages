import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { collectVerifiedFiles } from "../scripts/cli/verification.ts";
import extension from "../src/index.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
describe("shared runtime consumers", () => {
  it("registers one provider, the /ollama command and two tools after a real Pi session starts", async () => {
    const temp = mkdtempSync(join(tmpdir(), "ollama-consumer-"));
    const originalFetch = globalThis.fetch;
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalKey = process.env.OLLAMA_API_KEY;
    const originalTools = process.env.PI_OLLAMA_WEB_TOOLS;
    process.env.PI_CODING_AGENT_DIR = temp;
    delete process.env.OLLAMA_API_KEY;
    delete process.env.PI_OLLAMA_WEB_TOOLS;
    const fetchMock = vi.fn(async () => {
      throw new Error("Unexpected network request");
    });
    globalThis.fetch = fetchMock;
    try {
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      const modelRuntime = await ModelRuntime.create({
        authPath: join(temp, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(temp, "models-cache.json"),
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      const loader = new DefaultResourceLoader({
        cwd: temp,
        agentDir: temp,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [extension],
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({
        cwd: temp,
        agentDir: temp,
        settingsManager,
        modelRuntime,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(temp),
        noTools: "builtin",
      });
      try {
        await session.bindExtensions({ mode: "print" });
        expect(modelRuntime.getRegisteredProviderIds()).toEqual(["ollama-cloud"]);
        expect([...loader.getExtensions().extensions[0].commands.keys()].sort()).toEqual(["ollama"]);
        expect(session.getActiveToolNames().sort()).toEqual(["ollama_web_fetch", "ollama_web_search"]);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of Object.entries({
        PI_CODING_AGENT_DIR: originalAgentDir,
        OLLAMA_API_KEY: originalKey,
        PI_OLLAMA_WEB_TOOLS: originalTools,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("keeps runtime code in src without root compatibility facades", () => {
    const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    expect(manifest).toMatchObject({
      pi: { extensions: ["./src/index.ts"] },
      files: ["src/", "CHANGELOG.md", "CHANGELOG.ko.md", "README.md", "LICENSE"],
    });
    expect(readdirSync(packageRoot).filter((name) => name.endsWith(".ts"))).toEqual([]);
  });

  it("has a nonempty runtime graph without CLI or test dependencies", () => {
    const files = collectVerifiedFiles(["src/index.ts"]);
    expect(files.length).toBeGreaterThan(20);
    expect(files.some(({ path }) => /\/(scripts|test)\//.test(path))).toBe(false);
    expect(files.some(({ path }) => path.endsWith("src/models/catalog.ts"))).toBe(true);
    expect(files.some(({ path }) => path.endsWith("src/web/fetch.ts"))).toBe(true);
  });

  it("imports runtime and CLI modules without prompts, requests or credential reads", () => {
    const temp = mkdtempSync(join(tmpdir(), "ollama-import-"));
    try {
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
            'import "./src/index.ts";',
            'import "./scripts/cli.ts";',
            'import "./scripts/cli/core.ts";',
            'import "./scripts/cli/registry.ts";',
          ].join("\n"),
        ],
        {
          cwd: packageRoot,
          env: { ...process.env, PI_CODING_AGENT_DIR: temp, OLLAMA_API_KEY: "", OLLAMA_API_BASE: "", PI_OFFLINE: "1" },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
