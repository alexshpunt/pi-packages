import type { GenerationSources } from "../../scripts/lib/generation/catalog.ts";

export const fixtureIds = ["fixture-a", "fixture-b"];
export const fixturePricing = `<table><thead><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th></tr></thead><tbody>${fixtureIds.map((id) => `<tr><td><a href="/library/${id}">${id}</a></td><td>$1</td><td>$0.5</td><td>$2</td></tr>`).join("")}</tbody></table>`;
export const fixtureReasoning = {
  "ollama-cloud": {
    models: {
      "fixture-a": { reasoning_options: [{ type: "effort", values: ["low", "high"] }] },
      "fixture-b": { reasoning_options: [{ type: "toggle" }] },
    },
  },
};
export function fixtureDetails() {
  return {
    capabilities: ["tools", "thinking"],
    model_info: { "fixture.context_length": 131072 },
    thinking: { values: [false, "low", "high", "max"], default: "high" },
  };
}
export function createGenerationSources(): GenerationSources {
  return {
    list: async () => [...fixtureIds],
    detail: async () => fixtureDetails(),
    pricing: async () => fixturePricing,
    reasoning: async () => fixtureReasoning,
  };
}
