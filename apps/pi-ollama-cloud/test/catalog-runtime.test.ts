import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { withMockFetch } from "../scripts/cli/mock-transport.ts";
import { GENERATED_MODELS } from "../src/generated/catalog.generated.ts";
import { getCatalogDiagnostics, refreshOllamaCatalog } from "../src/models/catalog.ts";
import { isRecord } from "../src/models/types.ts";

describe("Pi ModelsStore catalog integration", () => {
  it("restores policy through two real runtimes and retains the last-good file on partial failure", async () => {
    const temp = mkdtempSync(join(tmpdir(), "ollama-runtime-catalog-"));
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_CODING_AGENT_DIR = temp;
    delete process.env.PI_OFFLINE;
    const authPath = join(temp, "auth.json");
    const modelsPath = join(temp, "models.json");
    const storePath = join(temp, "models-store.json");
    writeFileSync(authPath, JSON.stringify({ "ollama-cloud": { type: "api_key", key: "fixture" } }), { mode: 0o600 });
    writeFileSync(modelsPath, "{}");
    let isPartial = false;
    let listCalls = 0;
    async function createRuntime() {
      const runtime = await ModelRuntime.create({
        authPath,
        modelsPath,
        modelsStorePath: storePath,
        refreshOnCreate: false,
      });
      let finishInitialRestore!: () => void;
      const initialRestore = new Promise<void>((resolve) => {
        finishInitialRestore = resolve;
      });
      runtime.registerProvider("ollama-cloud", {
        api: "openai-completions",
        baseUrl: "https://ollama.com/v1",
        models: GENERATED_MODELS,
        refreshModels: async (context) => {
          try {
            return await refreshOllamaCatalog(context);
          } finally {
            if (!context.allowNetwork) finishInitialRestore();
          }
        },
      });
      // registerProvider starts an unawaited host refresh. Wait for that restore
      // callback rather than racing a second recompose against initialization.
      await initialRestore;
      const restored = await runtime.refresh({ allowNetwork: false, providers: ["ollama-cloud"] });
      expect([...restored.errors].map(([id, error]) => [id, error.message])).toEqual([]);
      return runtime;
    }
    try {
      await withMockFetch(
        async (url, init) => {
          if (String(url).endsWith("/v1/models")) {
            listCalls += 1;
            return Response.json({ data: [{ id: "glm-5.3-flash" }, { id: "beam" }] });
          }
          const request: unknown = JSON.parse(String(init?.body));
          if (!isRecord(request)) throw new Error("Invalid fixture request");
          if (isPartial && request.model === "beam") return new Response("fixture failure", { status: 500 });
          return Response.json({
            capabilities: ["tools", "thinking", "vision"],
            model_info: { "fixture.context_length": 222222 },
            thinking: { values: ["low", "high"], default: "high" },
          });
        },
        async () => {
          const first = await createRuntime();
          const fresh = await first.refresh({ allowNetwork: true, force: true, providers: ["ollama-cloud"] });
          expect([...fresh.errors]).toEqual([]);
          expect(first.getModels("ollama-cloud")).toHaveLength(2);
          expect(first.getModel("ollama-cloud", "glm-5.3-flash")?.contextWindow).toBe(222222);
          const serialized: unknown = JSON.parse(readFileSync(storePath, "utf8"));
          if (
            !isRecord(serialized) ||
            !isRecord(serialized["ollama-cloud"]) ||
            !Array.isArray(serialized["ollama-cloud"].models)
          )
            throw new Error("Missing actual Pi snapshot");
          for (const model of serialized["ollama-cloud"].models) {
            if (!isRecord(model)) throw new Error("Invalid snapshot model");
            model.maxTokens = 17;
            model.cost = { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 };
            model.compat = { supportsStore: true };
          }
          writeFileSync(storePath, JSON.stringify(serialized));
          const second = await createRuntime();
          expect(second.getModels("ollama-cloud")).toHaveLength(2);
          const restored = second.getModel("ollama-cloud", "glm-5.3-flash");
          expect(restored).toMatchObject({
            maxTokens: 524288,
            contextWindow: 222222,
            compat: { supportsStore: false },
            thinkingLevelMap: { low: "low", medium: null },
          });
          const beforeWarm = listCalls;
          await second.refresh({ allowNetwork: true, providers: ["ollama-cloud"] });
          expect(listCalls).toBe(beforeWarm);
          const beforeFailure = readFileSync(storePath);
          isPartial = true;
          const failed = await second.refresh({ allowNetwork: true, force: true, providers: ["ollama-cloud"] });
          expect([...failed.errors.keys()]).toEqual(["ollama-cloud"]);
          expect(second.getModels("ollama-cloud")).toHaveLength(2);
          expect(readFileSync(storePath)).toEqual(beforeFailure);
          expect(getCatalogDiagnostics()?.failures).toEqual([{ id: "beam", reason: "request failed" }]);
          const beforeRetry = listCalls;
          await second.refresh({ allowNetwork: true, providers: ["ollama-cloud"] });
          expect(listCalls).toBe(beforeRetry);
          const diagnostics: unknown = JSON.parse(
            readFileSync(join(temp, "cache/pi-ollama-cloud/catalog-state.json"), "utf8"),
          );
          expect(isRecord(diagnostics) && !("models" in diagnostics)).toBe(true);
        },
      );
    } finally {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
