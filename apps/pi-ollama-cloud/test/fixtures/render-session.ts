import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GENERATED_MODELS } from "../../src/generated/catalog.generated.ts";

const directory = resolve(process.argv[2]);
mkdirSync(directory, { recursive: true });
const manager = SessionManager.create(directory, join(directory, "sessions"));
manager.appendModelChange("ollama-cloud", GENERATED_MODELS[0].id);
manager.appendMessage({ role: "user", content: "Local renderer fixture, no model request.", timestamp: 1 });
for (const name of ["ollama_web_search", "ollama_web_fetch"]) {
  manager.appendMessage({
    role: "assistant",
    api: "openai-completions",
    provider: "ollama-cloud",
    model: GENERATED_MODELS[0].id,
    content: [
      {
        type: "toolCall",
        id: name,
        name,
        arguments: name === "ollama_web_search" ? { query: "fixture" } : { url: "https://example.test" },
      },
    ],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: name,
    toolName: name,
    content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `${name}-fixture-${i} 한글🙂`).join("\n") }],
    isError: false,
    timestamp: 3,
  });
}
const sessionPath = manager.getSessionFile();
if (!sessionPath) throw new Error("Fixture session was not saved.");
writeFileSync(join(directory, "session-path.txt"), sessionPath);
