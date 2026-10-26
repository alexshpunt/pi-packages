import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    pi.registerProvider("memory-ui-fixture", {
        baseUrl: "http://unused.invalid",
        api: "openai-completions",
        apiKey: "synthetic-ui-fixture",
        models: [{ id: "local", name: "Model-free UI fixture", reasoning: false, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
        streamSimple() { throw new Error("MODEL_REQUEST_FORBIDDEN_IN_UI_CHECK"); },
    });
}
