import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { budgetsFeature } from "../scripts/cli/budgets.ts";
import { withMockFetch } from "../scripts/cli/mock-transport.ts";
import { createCache } from "../src/cache/storage.ts";
import { registerWebFetchTool, registerWebSearchTool } from "../src/pi/web-tools.ts";
import { type createPagedResult, isWithinOutputBudget } from "../src/web/paging.ts";

function registered(cache: ReturnType<typeof createCache>) {
  const tools = new Map<string, ToolDefinition>();
  const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) };
  registerWebSearchTool(pi as unknown as ExtensionAPI, cache);
  registerWebFetchTool(pi as unknown as ExtensionAPI, cache);
  const ctx = { modelRegistry: { getApiKeyForProvider: async () => "fixture" } } as unknown as ExtensionToolContext;
  return {
    tools,
    async execute(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error("Missing registered tool");
      return (await tool.execute("fixture", params, undefined, undefined, ctx)) as ReturnType<typeof createPagedResult>;
    },
  };
}

describe("web budgets at the registered consumer", () => {
  it("passes exact cache/output and source reconstruction checks", async () => {
    await budgetsFeature.verify({
      check: async (_name, run) => {
        await run();
      },
    });
  });

  it.each(["ollama_web_fetch", "ollama_web_search"])(
    "paginates %s with bounded content and details, including a disk reload",
    async (name) => {
      const temp = mkdtempSync(join(tmpdir(), "ollama-budget-consumer-"));
      const path = join(temp, "cache.json");
      const source = Array.from({ length: 6000 }, (_, i) => `line-${i}-한글🙂`).join("\n");
      let calls = 0;
      const cache = createCache({ path });
      const consumer = registered(cache);
      expect(consumer.tools.get(name)?.parameters).toMatchObject({
        properties: { offset: { type: "integer", minimum: 0 } },
      });
      try {
        await withMockFetch(
          async () => {
            calls += 1;
            return name === "ollama_web_fetch"
              ? Response.json({ title: "fixture", content: source, links: [] })
              : Response.json({ results: [{ title: "fixture", url: "https://example.test", content: source }] });
          },
          async () => {
            let offset = 0;
            let combined = "";
            let iterations = 0;
            while (iterations++ < 20) {
              const params =
                name === "ollama_web_fetch"
                  ? { url: "https://example.test", full: true, offset }
                  : { query: "fixture", max_results: 3, expand: 1, offset };
              const current = offset === 0 ? consumer : registered(createCache({ path }));
              const result = await current.execute(name, params);
              expect(isWithinOutputBudget(result)).toBe(true);
              combined += result.content[0].text.slice(result.details.bodyStart, result.details.bodyEnd);
              if (result.details.nextOffset === undefined) break;
              expect(result.details.nextOffset).toBeGreaterThan(offset);
              offset = result.details.nextOffset;
            }
            expect(iterations).toBeLessThan(20);
            expect(combined).toBe(source);
            expect(calls).toBe(1);
          },
        );
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("exposes eviction and oversize-read diagnostics through the public cache contract", async () => {
    const temp = mkdtempSync(join(tmpdir(), "ollama-budget-storage-"));
    try {
      const path = join(temp, "cache.json");
      writeFileSync(path, "{".repeat(4096));
      const cache = createCache({ path, maxCacheBytes: 1024, maxMemoryBytes: 1024 });
      expect(cache.loadCache()).toEqual({ searches: {}, pages: {} });
      expect(cache.getDiagnostics?.().lastRead).toBe("oversized");
      await withMockFetch(
        async () => Response.json({ title: "fixture", content: "x".repeat(100000), links: [] }),
        async () => {
          const result = await registered(cache).execute("ollama_web_fetch", {
            url: "https://example.test",
            full: true,
          });
          expect(result.details.cacheRetained).toBe(false);
          expect(result.content[0].text).toContain("may call the API again");
          expect(isWithinOutputBudget(result)).toBe(true);
          expect(cache.getDiagnostics?.().retainedBytes).toBeLessThanOrEqual(1024);
        },
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
