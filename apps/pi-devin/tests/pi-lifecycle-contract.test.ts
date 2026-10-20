import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore,
  type AssistantMessage, type Model, type Provider, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const model: Model<"lifecycle-probe"> = {
  id: "probe", name: "Probe", provider: "lifecycle-probe", api: "lifecycle-probe", baseUrl: "https://example.invalid",
  reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 2048,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}
function response(value: AssistantMessage, before?: () => Promise<unknown>) {
  const stream = createAssistantMessageEventStream();
  void Promise.resolve().then(async () => {
    await before?.(); stream.push({ type: "start", partial: value });
    if (value.stopReason === "error" || value.stopReason === "aborted") stream.push({ type: "error", reason: value.stopReason, error: value });
    else stream.push({ type: "done", reason: value.stopReason as "stop" | "toolUse" | "length", message: value });
    stream.end(value);
  });
  return stream;
}

async function fixture(options: {
  stream: (context: TranscriptContext, options?: SimpleStreamOptions) => ReturnType<typeof createAssistantMessageEventStream>;
  observe: ExtensionFactory;
  tools?: ToolDefinition[];
  compaction?: boolean;
  seed?: (manager: SessionManager) => void;
}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-lifecycle-"));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(model.provider, async () => ({ type: "oauth", access: "fixture", refresh: "", expires: 0 }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  const provider: Provider<"lifecycle-probe"> = {
    id: model.provider, name: "Probe", getModels: () => [model],
    auth: { oauth: { name: "fixture", login: async () => { throw new Error("No login"); }, refresh: async (value) => value, toAuth: async (value) => ({ apiKey: value.access }) } },
    stream: (_model, context, options) => options ? optionsStream(context, options) : optionsStream(context),
    streamSimple: (_model, context, requestOptions) => options.stream(context, requestOptions),
  };
  function optionsStream(context: TranscriptContext, requestOptions?: SimpleStreamOptions) { return options.stream(context, requestOptions); }
  runtime.registerNativeProvider(provider);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: options.compaction ?? false, reserveTokens: 1000, keepRecentTokens: 0 },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
    cacheWarming: "off", enableInstallTelemetry: false, defaultProjectTrust: "never",
  });
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: join(directory, "agent"), settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    systemPrompt: "Offline lifecycle fixture", extensionFactories: [options.observe],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(directory); options.seed?.(manager);
  const { session } = await createAgentSession({ cwd: directory, agentDir: join(directory, "agent"), modelRuntime: runtime, model,
    thinkingLevel: "off", settingsManager: settings, sessionManager: manager, resourceLoader: loader,
    tools: options.tools?.map((tool) => tool.name) ?? [], customTools: options.tools,
  });
  await session.bindExtensions({ mode: "print" });
  return { session, manager, async close() { session.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test("real public agent: tool follow-ups and retries fall between one before_agent_start and the last settled", async () => {
  const events: string[] = []; let calls = 0, executions = 0;
  const requests: { sessionId?: string; timeoutMs?: number; toolResults: number }[] = [];
  const host = await fixture({
    observe: (pi) => {
      pi.on("before_agent_start", () => { events.push("before"); });
      pi.on("agent_start", () => { events.push("start"); });
      pi.on("agent_end", () => { events.push("end"); });
      pi.on("agent_settled", () => { events.push("settled"); });
    },
    tools: [{ name: "fixture_add", label: "Fixture", description: "Add controlled values",
      parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      execute: async () => { executions++; return { content: [{ type: "text", text: "3" }], details: {} }; },
    }],
    stream: (context, options) => {
      calls++; requests.push({ sessionId: options?.sessionId, timeoutMs: options?.timeoutMs, toolResults: context.messages.filter((entry) => entry.role === "toolResult").length });
      if (calls === 1) return response(message([{ type: "toolCall", id: "valid-tool", name: "fixture_add", arguments: { a: 1, b: 2 } }], "toolUse"));
      if (calls === 2) return response({ ...message([{ type: "toolCall", id: "failed-tool", name: "fixture_add", arguments: { a: 9, b: 9 } }], "error"), errorMessage: "HTTP 429 rate limit" });
      return response(message([{ type: "text", text: "done" }]));
    },
  });
  try {
    await host.session.prompt("offline add");
    assert.equal(calls, 3); assert.equal(executions, 1);
    assert.deepEqual(events, ["before", "start", "end", "start", "end", "settled"]);
    assert.deepEqual(requests.map((request) => request.toolResults), [0, 1, 1]);
    assert.equal(new Set(requests.map((request) => request.sessionId)).size, 1);
    assert.equal(requests.every((request) => request.timeoutMs === 300000), true);
  } finally { await host.close(); }
});

test("real public agent: threshold compaction before start requests before before_agent_start", async () => {
  const events: string[] = []; let calls = 0;
  const host = await fixture({ compaction: true,
    seed: (manager) => {
      manager.appendMessage({ role: "user", content: "Old conversation ".repeat(400), timestamp: 1 });
      const previous = message([{ type: "text", text: "old answer" }]);
      previous.usage.input = 9500; previous.usage.totalTokens = 9501;
      manager.appendMessage(previous);
    },
    observe: (pi) => {
      pi.on("session_before_compact", (event) => { events.push(`compact:${event.reason}`); });
      pi.on("session_compact", (event) => { events.push(`compacted:${event.reason}`); });
      pi.on("before_agent_start", () => { events.push("before"); });
      pi.on("agent_settled", () => { events.push("settled"); });
    },
    stream: () => { calls++; events.push("request"); return response(message([{ type: "text", text: "## Goal\nContinue offline verification.\n## Progress\nOld context summarized.\n## Next Steps\nProceed." }])); },
  });
  try {
    await host.session.prompt("Continue");
    assert.equal(calls, 2);
    assert.deepEqual(events, ["compact:threshold", "request", "compacted:threshold", "before", "request", "settled"]);
    assert.equal(host.manager.getBranch().some((entry) => entry.type === "compaction"), true);
  } finally { await host.close(); }
});
