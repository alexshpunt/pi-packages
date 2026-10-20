import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderFeature } from "../scripts/cli/render.ts";
import { registerWebFetchTool, registerWebSearchTool } from "../src/pi/web-tools.ts";
import type { createRenderResult } from "../src/render/result.ts";

describe("registered web result renderers", () => {
  it("passes the shared transition, result, theme and width checks", async () => {
    await renderFeature.verify({
      check: async (_name, run) => {
        await run();
      },
    });
  });

  it.each(["ollama_web_search", "ollama_web_fetch"])("keeps %s on the shared renderer without fallback", (name) => {
    const temp = mkdtempSync(join(tmpdir(), "ollama-render-consumer-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = temp;
    try {
      initTheme("dark", false);
      const renderers = new Map<string, ReturnType<typeof createRenderResult>>();
      const pi = {
        registerTool: (tool: { name: string; renderResult: ReturnType<typeof createRenderResult> }) =>
          renderers.set(tool.name, tool.renderResult),
      };
      registerWebSearchTool(pi as unknown as ExtensionAPI);
      registerWebFetchTool(pi as unknown as ExtensionAPI);
      const render = renderers.get(name);
      expect(render).toBeDefined();
      if (!render) throw new Error("Missing registered renderer");
      const context: Parameters<typeof render>[3] = {
        state: {},
        lastComponent: undefined,
        isError: false,
        invalidate() {},
      };
      const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
      for (const expanded of [false, true, false, true]) {
        for (const width of [20, 80]) {
          const component = render(
            { content: [{ type: "text", text: `registered-${expanded}-${width}` }], details: undefined },
            { expanded, isPartial: false },
            theme,
            context,
          );
          context.lastComponent = component;
          expect(component.render(width).join("\n")).toContain(`registered-${expanded}`);
        }
      }
      context.isError = true;
      const error = render(
        { content: [{ type: "text", text: "registered-error" }], details: undefined },
        { expanded: false, isPartial: false },
        theme,
        context,
      );
      expect(error.render(80).join("\n")).toContain("registered-error");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
