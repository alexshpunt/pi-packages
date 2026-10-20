import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import extension from "../../src/index.ts";

export default async function (pi: ExtensionAPI) {
  const path = process.env.OLLAMA_RENDER_OBSERVATIONS;
  if (!path) throw new Error("This fixture requires OLLAMA_RENDER_OBSERVATIONS.");
  const observations: { tool: string; expanded: boolean; width: number; lines: number }[] = [];
  const errors: string[] = [];
  let networkCalls = 0;
  const save = () => writeFileSync(path, JSON.stringify({ observations, errors, networkCalls }));
  globalThis.fetch = async () => {
    networkCalls += 1;
    save();
    throw new Error("Network is forbidden in the TUI fixture.");
  };
  const wrapped = new WeakSet<Component>();
  const current = new WeakMap<Component, { tool: string; expanded: boolean }>();
  pi.registerToolRenderer((name, next) => {
    const renderers = next();
    if (!name.startsWith("ollama_web_") || !renderers?.renderResult) return renderers;
    const render = renderers.renderResult;
    return {
      ...renderers,
      renderResult(result, options, theme, context) {
        try {
          const component = render(result, options, theme, context);
          if (!component) return component;
          current.set(component, { tool: name, expanded: options.expanded });
          if (!wrapped.has(component)) {
            wrapped.add(component);
            const renderComponent = component.render.bind(component);
            component.render = (width) => {
              const lines = renderComponent(width);
              const state = current.get(component);
              if (state) observations.push({ ...state, width, lines: lines.length });
              save();
              return lines;
            };
          }
          return component;
        } catch (error) {
          errors.push(error instanceof Error ? error.name : "renderer error");
          save();
          throw error;
        }
      },
    };
  });
  // The real package still registers its own provider, commands and lifecycle tools.
  await extension(pi);
  pi.on("session_shutdown", () => {
    save();
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR ?? "", "renderer-shutdown"), "done");
  });
}
