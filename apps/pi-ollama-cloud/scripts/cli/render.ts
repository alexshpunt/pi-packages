import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentToolResult, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createRenderResult } from "../../src/render/result.ts";
import { runFeature, type VerificationFeature } from "./verification.ts";

export const renderFeature: VerificationFeature = {
  id: "06-tool-renderer",
  cli: "scripts/cli/render.ts",
  shared: ["src/render/result.ts"],
  consumers: ["src/pi/web-tools.ts", "web-tools.ts"],
  async verify({ check }) {
    const temp = mkdtempSync(join(tmpdir(), "ollama-render-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = temp;
    try {
      initTheme("dark", false);
      const renderer = createRenderResult();
      const context: Parameters<typeof renderer>[3] = {
        state: {},
        lastComponent: undefined,
        isError: false,
        invalidate() {},
      };
      const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
      const result = (text: string): AgentToolResult<unknown> => ({
        content: [{ type: "text", text }],
        details: undefined,
      });
      const longText = Array.from({ length: 20 }, (_, i) => `fixture-${i} 한글🙂`).join("\n");
      const display = (text: string, expanded: boolean, width: number, style = theme) => {
        const component = renderer(result(text), { expanded, isPartial: false }, style, context);
        context.lastComponent = component;
        const lines = component.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        return lines.join("\n");
      };
      await check("접기↔펼치기 반복 및 성공→오류 전환에서 setText 예외 없음", async () => {
        for (let i = 0; i < 3; i++) {
          display(longText, false, 60);
          assert.match(display(longText, true, 60), /fixture-0/);
        }
        display(longText, false, 60);
        context.isError = true;
        assert.match(display("fixture-error", false, 60), /fixture-error/);
        context.isError = false;
        display("", false, 20);
      });
      await check("동일 폭의 새 결과와 테마·폭 변경에 preview 갱신", async () => {
        display("old-result", false, 60);
        assert.match(display("new-result", false, 60), /new-result/);
        const changedTheme = { fg: (_color: string, text: string) => `changed:${text}` } as unknown as Theme;
        assert.match(display("new-result", false, 60, changedTheme), /changed:new-result/);
        display(longText, false, 12);
        display(longText, false, 80);
        context.lastComponent?.invalidate();
        assert.match(display("after-invalidate", false, 30), /after-invalidate/);
      });
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(temp, { recursive: true, force: true });
    }
  },
};
runFeature(import.meta.url, renderFeature);
