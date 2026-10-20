import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, normalizeContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerDevinExtension } from "../src/pi/extension.ts";
import { DEVIN_COMMAND_NAME, registerDevinCommand, updateUsageStatus, USAGE_STATUS_KEY } from "../src/pi/devin-command.ts";
import { DevinPanel } from "../src/pi/devin-panel.ts";
import { DEFAULT_PREFERENCES, devinSettingsPath, fileDevinSettings, memoryDevinSettings } from "../src/pi/devin-settings.ts";
import { FusionPicker } from "../src/pi/fusion-picker.ts";
import { formatTokens, progressBar, relativeTime, remainingTone, sessionUsage, usageReport, usageStatusText } from "../src/pi/usage.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fileFusionSettings, fusionSettingsPath, memoryFusionSettings } from "../src/pi/fusion-settings.ts";
import { FUSION_MODEL_ID, type DevinModel } from "../src/pi/models.ts";
import { FUSION_CHILD_ENV, SIDEKICK_REPORT_MESSAGE, type SidekickToolOptions } from "../src/pi/sidekick.ts";
import { extensionArgs, PACKAGE_ROOT } from "../src/pi/sidekick-runtime.ts";
import { SIDEKICK_REPORT_CHAR_LIMIT } from "../src/pi/sidekick-report.ts";
import type { DevinProvider } from "../src/pi/provider.ts";
import { DEVIN_STATE_ENTRY } from "../src/pi/lifecycle.ts";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import type { JsonObject } from "../src/core/types.ts";
import { errorStreamResponse, finalFrames, MODELS_METHOD, streamResponse } from "./helpers.ts";
import { providerCredential, providerFixture, type CapturedProviderRequest } from "./provider-fixture.ts";

const usageFrame = { usage: { inputTokens: 3, outputTokens: 2 } };
const callFrames = (id: string, name: string, args: JsonObject) => [
  { deltaToolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }] }, { stopReason: "STOP_REASON_FUNCTION_CALL" }, usageFrame,
];


/** Fake sidekick child Pi that only exchanges RPC JSONL. Real Pi runs are checked separately by host-contract. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: JsonObject[] = [];
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly stdin: Writable;
  constructor(script: (command: JsonObject, child: FakeChild) => void) {
    super();
    let buffer = "";
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      buffer += String(chunk);
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const command = JSON.parse(buffer.slice(0, index)) as JsonObject;
        buffer = buffer.slice(index + 1);
        this.commands.push(command);
        script(command, this);
      }
      callback();
    } });
  }
  send(record: JsonObject) { this.stdout.write(JSON.stringify(record) + "\n"); }
  /** Ends one child run. The last assistant text is returned in the get_last_assistant_text response. */
  settle(text: string, options: { tools?: string[]; aborted?: boolean } = {}) {
    for (const tool of options.tools ?? []) this.send({ type: "tool_execution_start", toolName: tool, toolCallId: tool });
    this.send({ type: "message_end", message: { role: "assistant", stopReason: options.aborted ? "aborted" : "stop" } });
    this.lastText = text;
    this.send({ type: "agent_settled", aborted: options.aborted === true });
  }
  lastText = "";
  kill(signal?: string) { this.signalCode = signal ?? "SIGTERM"; queueMicrotask(() => this.emit("close", null, this.signalCode)); return true; }
}
function fakeSidekick(script: (command: JsonObject, child: FakeChild) => void) {
  const spawned: { command: string; args: string[]; options: { cwd?: string; env?: Record<string, string | undefined> }; child: FakeChild }[] = [];
  const respond = (command: JsonObject, child: FakeChild) => {
    if (command.type === "get_last_assistant_text") child.send({ type: "response", id: command.id, command: command.type, success: true, data: { text: child.lastText } });
    else script(command, child);
  };
  const spawn = ((command: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined> }) => {
    const child = new FakeChild(respond);
    spawned.push({ command, args, options, child });
    return child;
  }) as unknown as NonNullable<SidekickToolOptions["runtime"]>["spawn"];
  return { spawned, runtime: { spawn, resolveCommand: () => ({ command: "fake-pi", args: ["fake-cli.js"] }) } };
}
const waitUntil = async (predicate: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 500 && !predicate(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), label);
};

/** Loads the Devin extension through the public loader, AgentSession and OAuth, and finds the Pi-style Fusion model. */
async function fusionSession(chat: (request: CapturedProviderRequest, index: number) => Response | Promise<Response>, maxModelCalls?: number,
  sidekick?: Partial<SidekickToolOptions>, catalog?: JsonObject) {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-fusion-"));
  const fixture = await providerFixture({ chat, maxModelCalls, catalog });
  fixture.provider.shutdown();
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(directory, "models.json"),
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  const settings = SettingsManager.inMemory({ defaultProjectTrust: "never", enableInstallTelemetry: false, cacheWarming: "off",
    compaction: { enabled: false }, retry: { enabled: false } });
  let provider!: DevinProvider, ready!: () => void;
  const restored = new Promise<void>((resolve) => { ready = resolve; });
  const fusionSettings = memoryFusionSettings(), devinSettings = memoryDevinSettings();
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: join(directory, "agent"), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "Use the declared tools.", extensionFactories: [(pi) => {
      provider = registerDevinExtension(pi, { ...fixture.dependencies, fusionSettings, devinSettings,
        sidekick: { agentDir: () => join(directory, "agent"), ...sidekick } });
      const refresh = provider.refreshModels;
      provider.refreshModels = async (context) => { await refresh(context); if (!context.allowNetwork) ready(); };
    }],
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  let additions = 0;
  const tool: ToolDefinition = { name: "fixture_add", label: "Fixture", description: "Add two controlled numbers",
    parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    execute: async (_id, args) => { additions++; const value = args as { a: number; b: number }; return { content: [{ type: "text", text: String(value.a + value.b) }], details: {} }; },
  };
  const manager = SessionManager.create(directory, join(directory, "sessions"));
  const { session } = await createAgentSession({ cwd: directory, agentDir: join(directory, "agent"), modelRuntime: runtime, model: fixture.model,
    // The sidekick must be in the allowlist (like `--tools`) for the extension to activate it.
    thinkingLevel: "medium", settingsManager: settings, sessionManager: manager, resourceLoader: loader, tools: [tool.name, "devin_sidekick"], customTools: [tool],
  });
  const errors: string[] = [];
  await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error.error); } });
  await restored;
  await runtime.login("devin", "oauth", { notify: () => {}, prompt: async (prompt) => prompt.type === "select" ? "manual" : "ordinary-fusion-code" });
  assert.equal((await runtime.refresh({ providers: ["devin"], allowNetwork: true, force: true })).errors.size, 0);
  const fusion = runtime.getModels("devin").find((model) => model.id === FUSION_MODEL_ID) as DevinModel;
  assert.ok(fusion, "fusion model");
  const chats = () => fixture.requests.filter((entry) => entry.method === CHAT_METHOD);
  return { directory, fixture, runtime, session, manager, errors, fusion, fusionSettings, devinSettings, chats, additions: () => additions, provider: () => provider,
    dispose: async () => { provider?.shutdown(); session.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test("public loader → OAuth → model/thinking → tool results, host retry and env headers are wired end to end", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-e2e-"));
  const fixture = await providerFixture({ chat: (request, index) => {
    if (index <= 3) assert.equal(request.body.chatModelUid, "swe-2-high");
    if (index === 1) return streamResponse([
      { deltaThinking: "plan", deltaSignature: "native-signature", deltaSignatureType: "native-kind" },
      { deltaToolCalls: [{ id: "actual-tool", name: "fixture_add", argumentsJson: '{"a":1,"b":2}' }] },
      { stopReason: "STOP_REASON_FUNCTION_CALL" }, { usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
    if (index === 2) return errorStreamResponse("resource_exhausted", "HTTP 429", [
      { deltaText: "failed partial", deltaToolCalls: [{ id: "failed-tool", name: "fixture_add", argumentsJson: '{"a":9,"b":9}' }] },
    ]);
    if (index === 4) assert.equal(request.headers.get("x-env"), "request-override");
    return streamResponse(finalFrames("done"));
  } });
  fixture.provider.shutdown();
  const credentials = new InMemoryCredentialStore(), modelsStore = new InMemoryModelsStore();
  const configPath = join(directory, "models.json");
  const runtime = await ModelRuntime.create({ credentials, modelsPath: configPath, modelsStore, refreshOnCreate: false, allowModelNetwork: false });
  assert.equal(runtime.getProvider("devin"), undefined, "ID collision in the default registry under test");
  const settings = SettingsManager.inMemory({ defaultProjectTrust: "never", enableInstallTelemetry: false, cacheWarming: "off",
    compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
  });
  const events: string[] = [], errors: string[] = [];
  let provider!: DevinProvider, ready!: () => void;
  const restored = new Promise<void>((resolve) => { ready = resolve; });
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: join(directory, "agent"), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "Only use the declared fixture tool.", extensionFactories: [(pi) => {
      provider = registerDevinExtension(pi, fixture.dependencies);
      const refresh = provider.refreshModels;
      provider.refreshModels = async (context) => { await refresh(context); if (!context.allowNetwork) ready(); };
      pi.on("agent_start", () => { events.push("start"); });
      pi.on("agent_end", () => { events.push("end"); });
      pi.on("agent_settled", () => { events.push("settled"); });
    }],
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  let toolExecutions = 0;
  const tool: ToolDefinition = { name: "fixture_add", label: "Fixture", description: "Add two controlled numbers",
    parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    execute: async (_id, args) => { toolExecutions++; const value = args as { a: number; b: number }; return { content: [{ type: "text", text: String(value.a + value.b) }], details: {} }; },
  };
  const manager = SessionManager.create(directory, join(directory, "sessions"));
  const { session } = await createAgentSession({ cwd: directory, agentDir: join(directory, "agent"), modelRuntime: runtime, model: fixture.model,
    thinkingLevel: "medium", settingsManager: settings, sessionManager: manager, resourceLoader: loader, tools: [tool.name], customTools: [tool],
  });
  try {
    await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error.error); } });
    await restored;
    assert.equal(runtime.getProviders().filter((entry) => entry.id === "devin").length, 1);
    assert.ok(runtime.getProvider("devin")!.auth.oauth); assert.equal(runtime.getProvider("devin")!.auth.apiKey, undefined);
    await runtime.login("devin", "oauth", { notify: () => {}, prompt: async (prompt) => prompt.type === "select" ? "manual" : "ordinary-e2e-code" });
    const refresh = await runtime.refresh({ providers: ["devin"], allowNetwork: true, force: true });
    assert.equal(refresh.aborted, false); assert.equal(refresh.errors.size, 0);
    const model = runtime.getModels("devin").find((model) => model.id === "swe-2")!;
    await session.setModel(model); session.setThinkingLevel("high");
    await session.prompt("Add one and two.");
    assert.deepEqual(errors, []);
    assert.equal(toolExecutions, 1); assert.equal(fixture.chatCalls(), 3);
    assert.deepEqual(events, ["start", "end", "start", "end", "settled"]);
    assert.equal(session.getLastAssistantText(), "done");
    const requests = fixture.requests.filter((entry) => entry.method === CHAT_METHOD);
    assert.equal(new Set(requests.map((entry) => entry.body.executionId)).size, 1);
    assert.equal(requests.every((entry) => entry.body.clientSessionId === manager.getSessionId()), true);
    const finalPrompts = requests[2].body.chatMessagePrompts as JsonObject[];
    assert.equal(finalPrompts.filter((entry) => entry.toolCallId === "actual-tool").length, 1);
    assert.equal(JSON.stringify(finalPrompts).includes("failed-tool"), false);
    const assistant = finalPrompts.find((entry) => Array.isArray(entry.toolCalls))!;
    assert.equal(assistant.modelUid, "swe-2-high"); assert.equal(assistant.signature, "native-signature");
    const state = provider.lifecycle.snapshot(); assert.equal(state.execution!.used, 3); assert.equal(state.execution!.settled, true);
    const stored = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === DEVIN_STATE_ENTRY);
    assert.ok(stored.length > 0);
    assert.equal(JSON.stringify(stored).includes(providerCredential.sessionToken), false);
    assert.ok(manager.getSessionFile()); assert.match(await readFile(manager.getSessionFile()!, "utf8"), /pi-devin.state.v1/);
    // Pi 1.3's per-request env is consumed by per-model header resolution.
    // Provider-level OAuth headers are resolved earlier through credential.env, which is a different contract.
    await writeFile(configPath, JSON.stringify({ providers: { devin: { modelOverrides: { [model.id]: { headers: { "x-env": "$REQUEST_LABEL" } } } } } }));
    await runtime.refresh({ providers: ["devin"], allowNetwork: false });
    const modelWithHeader = runtime.getModel("devin", model.id)!;
    const answer = await runtime.completeSimple(modelWithHeader, { messages: [{ role: "user", content: "env", timestamp: 2 }] }, { reasoning: "medium", env: { REQUEST_LABEL: "request-override" } });
    assert.equal(answer.stopReason, "stop", answer.errorMessage ?? "unexpected finish"); assert.equal(fixture.chatCalls(), 4);
    provider.lifecycle.finish();
    runtime.registerNativeProvider({ ...provider });
    await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
    assert.equal(errors.length, 1); assert.match(errors[0], /collides/);
    const before = fixture.chatCalls();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    const closed = await provider.streamSimple(fixture.model, normalizeContext({ messages: [] }), { apiKey: providerCredential.sessionToken }).result();
    assert.equal(closed.stopReason, "aborted"); assert.equal(fixture.chatCalls(), before);
  } finally {
    provider?.shutdown(); session.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

test("Pi-style Fusion: the child Pi sidekick runs with the lead's tools and session scope, returns its report as the tool result and is reused within the session", { timeout: 30_000 }, async () => {
  let handoffs = 0;
  const fake = fakeSidekick((command, child) => {
    if (command.type === "prompt") setImmediate(() => child.settle(`sidekick report ${++handoffs}`, { tools: ["fixture_add"] }));
  });
  const f = await fusionSession((_request, index) => {
    switch (index) {
      case 1: return streamResponse(callFrames("lead-1", "devin_sidekick", { message: "Add 1 and 2 with fixture_add." }));
      case 3: return streamResponse(callFrames("lead-3", "devin_sidekick", { message: "Report the earlier sum again." }));
      default: return streamResponse(finalFrames(`lead done ${index}`));
    }
  }, undefined, { runtime: fake.runtime });
  try {
    const { session } = f;
    assert.equal(session.getActiveToolNames().includes("devin_sidekick"), false);
    await session.setModel(f.fusion); session.setThinkingLevel("high");
    assert.deepEqual(session.getActiveToolNames().sort(), ["devin_sidekick", "fixture_add"]);
    await session.prompt("Use your sidekick to add one and two.");
    await session.prompt("Ask the sidekick again.");
    assert.deepEqual(f.errors, []);
    // Only the lead calls Devin in this process. The child runs the sidekick's tools, so the lead runs none.
    const chats = f.chats().map((entry) => entry.body);
    assert.deepEqual(chats.map((body) => body.chatModelUid), ["swe-2-high", "swe-2-high", "swe-2-high", "swe-2-high"]);
    assert.equal(f.additions(), 0);
    assert.match(chats[0].prompt as string, /^Use the declared tools\.[\s\S]*\n\nFusion mode: you are the lead[\s\S]*`block: false`/);
    assert.deepEqual(((chats[0].tools ?? []) as JsonObject[]).map((tool) => tool.name).sort(), ["devin_sidekick", "fixture_add"]);
    assert.equal(JSON.stringify(chats[1].chatMessagePrompts).includes("sidekick report 1"), true);
    assert.equal(JSON.stringify(chats[3].chatMessagePrompts).includes("sidekick report 2"), true);
    // One child per lead session, started with the lead's cwd and tools, the Fusion guard environment and this package path.
    assert.equal(fake.spawned.length, 1);
    const [{ command, args, options, child }] = fake.spawned;
    assert.equal(command, "fake-pi");
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    assert.deepEqual([args[0], value("--mode"), value("--model"), value("--thinking"), value("-e"), value("--tools")],
      ["fake-cli.js", "rpc", "devin/swe-2-medium", "medium", PACKAGE_ROOT, "fixture_add"]);
    assert.equal(value("--session"), join(f.directory, "agent", "pi-devin", "sidekick", `${f.manager.getSessionId()}.jsonl`));
    assert.match(value("--append-system-prompt"), /You are the sidekick/);
    assert.deepEqual([options.cwd, options.env?.[FUSION_CHILD_ENV]], [f.directory, "1"]);
    assert.deepEqual(child.commands.map((entry) => entry.type), ["prompt", "get_last_assistant_text", "prompt", "get_last_assistant_text"]);
    assert.deepEqual(child.commands.filter((entry) => entry.type === "prompt").map((entry) => entry.message), ["Add 1 and 2 with fixture_add.", "Report the earlier sum again."]);
    const handoff = session.messages.find((message) => message.role === "toolResult" && message.toolName === "devin_sidekick");
    assert.ok(handoff && handoff.role === "toolResult");
    assert.deepEqual([(handoff.details as JsonObject).status, (handoff.details as JsonObject).toolCalls], ["completed", 1]);
    // Switching to a non-Fusion model turns the tool off, and session shutdown cleans up the child.
    await session.setModel(f.runtime.getModels("devin").find((model) => model.id === f.fusion.devin.fusion!.leadID)!);
    assert.deepEqual(session.getActiveToolNames(), ["fixture_add"]);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(child.signalCode, "SIGTERM");
  } finally { await f.dispose(); }
});

test("Pi-style Fusion: block:false, steer and user input while waiting move work to the background, the report reaches the lead once, and cancel stops the child task", { timeout: 30_000 }, async () => {
  const fake = fakeSidekick(() => {});
  const f = await fusionSession((_request, index) => {
    switch (index) {
      case 1: return streamResponse(callFrames("lead-1", "devin_sidekick", { message: "Long task.", block: false }));
      case 3: return streamResponse(callFrames("lead-3", "devin_sidekick", { message: "Also check the tests.", block: false }));
      case 6: return streamResponse(callFrames("lead-6", "devin_sidekick", { message: "Slow task." }));
      case 9: return streamResponse(callFrames("lead-9", "devin_sidekick", { message: "Cancel me." }));
      default: return streamResponse(finalFrames(`lead done ${index}`));
    }
  }, undefined, { runtime: fake.runtime });
  try {
    const { session } = f;
    await session.setModel(f.fusion);
    // block:false returns at once and the lead finishes. The child is still working.
    await session.prompt("Start the long task in the background.");
    assert.equal(f.chats().length, 2);
    const child = () => fake.spawned[0].child;
    assert.match(JSON.stringify(f.chats()[1].body.chatMessagePrompts), /started working in the background/);
    // A call during a run joins the same handoff as a steer, not a new prompt.
    await session.prompt("Add a follow-up instruction.");
    assert.deepEqual(child().commands.map((entry) => entry.type), ["prompt", "steer"]);
    assert.equal(child().commands[1].message, "Also check the tests.");
    assert.match(JSON.stringify(f.chats()[3].body.chatMessagePrompts), /Added instructions to the running sidekick task/);
    // When the report arrives, a followUp message wakes the lead exactly once.
    child().settle("background report done");
    await waitUntil(() => f.chats().length === 5 && !session.isStreaming, "background report wakes the lead");
    const woken = JSON.stringify(f.chats()[4].body.chatMessagePrompts);
    assert.match(woken, /Sidekick report for background handoff [0-9a-f]{8}/);
    assert.equal(woken.includes("background report done"), true);
    assert.equal(session.messages.filter((message) => message.role === "custom" && message.customType === SIDEKICK_REPORT_MESSAGE).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.chats().length, 5);

    // User input while waiting moves the handoff to the background.
    const running = session.prompt("Run the slow task and wait.");
    await waitUntil(() => child().commands.filter((entry) => entry.type === "prompt").length === 2, "slow handoff started");
    await session.steer("I have another question.");
    await running;
    await waitUntil(() => !session.isStreaming, "lead finished after interruption");
    const interrupted = session.messages.filter((message) => message.role === "toolResult" && message.toolName === "devin_sidekick").at(-1);
    assert.ok(interrupted && interrupted.role === "toolResult");
    assert.equal((interrupted.details as JsonObject).status, "background");
    const beforeReport = f.chats().length;
    child().settle("slow report done");
    await waitUntil(() => f.chats().length === beforeReport + 1 && !session.isStreaming, "interrupted report delivered");
    assert.equal(JSON.stringify(f.chats().at(-1)!.body.chatMessagePrompts).includes("slow report done"), true);

    // Cancelling the lead sends abort to the waiting handoff, and the stopped report is not delivered.
    const cancelled = session.prompt("Run something and then cancel.");
    await waitUntil(() => child().commands.filter((entry) => entry.type === "prompt").length === 3, "cancel handoff started");
    await session.abort();
    await cancelled.catch(() => {});
    assert.equal(child().commands.at(-1)!.type, "abort");
    const afterAbort = f.chats().length;
    child().settle("", { aborted: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.chats().length, afterAbort);
    assert.equal(session.messages.filter((message) => message.role === "custom" && message.customType === SIDEKICK_REPORT_MESSAGE).length, 2);
    assert.equal(fake.spawned.length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.dispose(); }
});

test("Pi-style Fusion: an oversized sidekick report reaches the lead bounded as a tool result, a failure and a background message, with the complete text saved", { timeout: 30_000 }, async () => {
  const reportLine = "보고서 줄 ✅ verified\n";
  const original = `HEAD-MARKER\n${reportLine.repeat(Math.ceil(SIDEKICK_REPORT_CHAR_LIMIT / reportLine.length) + 100)}TAIL-MARKER`;
  const boundedLength = SIDEKICK_REPORT_CHAR_LIMIT + 1000;
  let prompts = 0;
  const fake = fakeSidekick((command, child) => {
    if (command.type !== "prompt") return;
    prompts++;
    if (prompts === 1) setImmediate(() => child.settle(original));
    else if (prompts === 2) setImmediate(() => {
      // The child's last assistant message ends with an error, so the tool fails with the report attached.
      child.send({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "boom" } });
      child.lastText = original;
      child.send({ type: "agent_settled", aborted: false });
    });
  });
  const f = await fusionSession((_request, index) => {
    switch (index) {
      case 1: return streamResponse(callFrames("lead-1", "devin_sidekick", { message: "Write a long report." }));
      case 3: return streamResponse(callFrames("lead-3", "devin_sidekick", { message: "Fail with a long report." }));
      case 5: return streamResponse(callFrames("lead-5", "devin_sidekick", { message: "Long background report.", block: false }));
      default: return streamResponse(finalFrames(`lead done ${index}`));
    }
  }, undefined, { runtime: fake.runtime });
  const savedReports: string[] = [];
  const resultText = (message: { content: unknown }) => (message.content as { text?: string }[]).map((block) => block.text ?? "").join("");
  try {
    const { session } = f;
    await session.setModel(f.fusion);
    const results = () => session.messages.filter((message) => message.role === "toolResult" && message.toolName === "devin_sidekick");

    await session.prompt("Get the long report.");
    const completed = results()[0];
    assert.ok(completed && completed.role === "toolResult");
    const completedText = resultText(completed), fullReportPath = (completed.details as JsonObject).fullReportPath as string;
    savedReports.push(fullReportPath);
    assert.equal(completed.isError, false);
    assert.ok(completedText.startsWith("HEAD-MARKER") && !completedText.includes("TAIL-MARKER") && completedText.length < boundedLength, `${completedText.length}`);
    assert.equal(await readFile(fullReportPath, "utf8"), original);
    // The next lead request carries the bounded text, not the original.
    const leadSaw = JSON.stringify(f.chats()[1].body.chatMessagePrompts);
    assert.ok(leadSaw.includes(`Full report: ${fullReportPath}`) && !leadSaw.includes("TAIL-MARKER"));

    await session.prompt("Get the failing report.");
    const failed = results()[1];
    assert.ok(failed && failed.role === "toolResult");
    const failedText = resultText(failed);
    savedReports.push(/Full report: (\S+)\]$/.exec(failedText)?.[1] ?? "");
    assert.equal(failed.isError, true);
    assert.match(failedText, /^The sidekick task failed: boom\n\nHEAD-MARKER/);
    assert.ok(!failedText.includes("TAIL-MARKER") && failedText.length < boundedLength, `${failedText.length}`);

    await session.prompt("Start the background report.");
    const before = f.chats().length;
    fake.spawned[0].child.settle(original);
    await waitUntil(() => f.chats().length === before + 1 && !session.isStreaming, "background report wakes the lead");
    const report = session.messages.filter((message) => message.role === "custom" && message.customType === SIDEKICK_REPORT_MESSAGE).at(-1);
    assert.ok(report && report.role === "custom" && typeof report.content === "string");
    savedReports.push((report.details as JsonObject).fullReportPath as string);
    assert.ok(report.content.includes("HEAD-MARKER") && !report.content.includes("TAIL-MARKER") && report.content.length < boundedLength, `${report.content.length}`);
    assert.equal(await readFile(savedReports[2], "utf8"), original);
    assert.equal(JSON.stringify(f.chats().at(-1)!.body.chatMessagePrompts).includes("TAIL-MARKER"), false);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.dispose();
    for (const path of savedReports) if (path) await rm(dirname(path), { recursive: true, force: true });
  }
});

test("the sidekick child Pi registers no Fusion model, sidekick tool or /devin-fusion command", async () => {
  const fixture = await providerFixture();
  fixture.provider.shutdown();
  const registered: string[] = [];
  const pi = { registerProvider: () => {}, registerTool: (tool: { name: string }) => { registered.push(`tool:${tool.name}`); },
    registerCommand: (name: string) => { registered.push(`command:${name}`); }, getActiveTools: () => [], setActiveTools: () => {}, on: () => () => {} };
  const provider = registerDevinExtension(pi as never, { ...fixture.dependencies, isFusionChild: true });
  try {
    await provider.refreshModels({ credential: { type: "oauth", access: providerCredential.sessionToken, refresh: "", expires: 0,
      devin: { version: 1, apiServerURL: providerCredential.apiServerURL, createdAt: providerCredential.createdAt } } as never,
      allowNetwork: true, force: true, signal: new AbortController().signal, publish: async (value) => { value.update?.(); return true; } });
    assert.deepEqual(registered, []);
    assert.ok(provider.getModels().length > 0);
    assert.equal(provider.getModels().some((model) => model.id === FUSION_MODEL_ID), false);
    assert.equal(provider.getFusionChoices(), undefined);
    // Only extension selection arguments are passed so the child also gets tools from extensions loaded with `-e` in the lead CLI.
    assert.deepEqual(extensionArgs(["--mode", "rpc", "-e", "./ext", "--extension", "/abs/ext", "-e", "npm:@scope/pkg", "--no-extensions", "--no-mcp", "--model", "m", "-e"], "/work"),
      ["-e", "/work/ext", "-e", "/abs/ext", "-e", "npm:@scope/pkg", "--no-extensions", "--no-mcp"]);
  } finally { provider.shutdown(); }
});

test("/devin-fusion: a lead/sidekick chosen by arguments is written to the global store and applied to the current Fusion model at once", async () => {
  const f = await fusionSession(() => streamResponse(finalFrames("unused")));
  try {
    const { session } = f;
    assert.equal(f.runtime.getModels("devin").filter((model) => model.id === FUSION_MODEL_ID).length, 1);
    await session.setModel(f.fusion);
    const choices = f.provider().getFusionChoices()!;
    const leadID = f.fusion.devin.fusion!.leadID;
    assert.ok(choices.leads.some((item) => item.id === leadID));
    await session.prompt(`/devin-fusion ${leadID} swe-2-high`);
    assert.equal(leadID, "swe-2");
    const selected = { leadID, sidekickID: "swe-2-high" };
    assert.deepEqual(f.fusionSettings.read(), selected);
    // The current session model is replaced with a new object of the same ID, so the name and pair match immediately.
    const current = session.model as DevinModel;
    assert.equal(current.id, FUSION_MODEL_ID);
    assert.deepEqual(current.devin.fusion, selected);
    assert.equal(current.name, "Devin Fusion · SWE-2 + SWE-2 High");
    assert.equal(session.getActiveToolNames().includes("devin_sidekick"), true);
    // Pi's model and availability snapshots update even when the current model is not Fusion.
    await session.setModel(f.runtime.getModel("devin", leadID)!);
    await session.prompt(`/devin-fusion ${leadID} swe-2-max`);
    const snapshot = f.runtime.getAvailableSnapshot().find((model) => model.id === FUSION_MODEL_ID) as DevinModel | undefined;
    assert.deepEqual([snapshot?.devin.fusion?.sidekickID, f.runtime.getModel("devin", FUSION_MODEL_ID)?.name === "Devin Fusion · SWE-2 + SWE-2 Max"], ["swe-2-max", true]);
    await session.prompt(`/devin-fusion ${leadID} swe-2-high`);
    // Models not in the list and bad arguments leave the saved value unchanged. The command sends no model request.
    await session.prompt(`/devin-fusion ${leadID} not-a-model`);
    await session.prompt("/devin-fusion only-one-argument");
    assert.deepEqual(f.fusionSettings.read(), selected);
    assert.equal(f.chats().length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.dispose(); }
});

test("Fusion global store: corrupt or malformed files read as defaults and are not overwritten; writes use schemaVersion 1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-fusion-settings-"));
  try {
    const path = fusionSettingsPath(join(directory, "agent"));
    assert.equal(path, join(directory, "agent", "pi-devin", "fusion.json"));
    const store = fileFusionSettings(path);
    assert.equal(store.read(), undefined);
    store.write({ leadID: "swe-2", sidekickID: "swe-2-high" });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { schemaVersion: 1, leadID: "swe-2", sidekickID: "swe-2-high" });
    assert.deepEqual(store.read(), { leadID: "swe-2", sidekickID: "swe-2-high" });
    // A file saved in the legacy format is read as is. effectiveFusion maps it to the new IDs.
    await writeFile(path, JSON.stringify({ schemaVersion: 1, leadID: "family:lead", sidekickID: "uid:side" }));
    assert.deepEqual(store.read(), { leadID: "family:lead", sidekickID: "uid:side" });
    for (const invalid of ["{broken", JSON.stringify({ schemaVersion: 2, leadID: "swe-2", sidekickID: "swe-2-high" }), JSON.stringify({ schemaVersion: 1, leadID: " ", sidekickID: "swe-2-high" }), JSON.stringify({ schemaVersion: 1, leadID: "swe-2", sidekickID: 7 })]) {
      await writeFile(path, invalid);
      assert.equal(store.read(), undefined);
      assert.equal(await readFile(path, "utf8"), invalid);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("/devin: a recommended filter changed by argument is saved globally and applied to the Pi model list at once without network", async () => {
  // The full fixture catalog has groups with and without a variant marked isRecommended.
  const catalog = JSON.parse(await readFile(new URL("./fixtures/model-catalog.json", import.meta.url), "utf8")) as JsonObject;
  const recommendedUIDs = new Set((catalog.clientModelConfigs as JsonObject[]).filter((config) => config.isRecommended === true).map((config) => config.modelUid as string));
  const f = await fusionSession(() => streamResponse(finalFrames("unused")), undefined, undefined, catalog);
  try {
    const { session } = f;
    const catalogRequests = () => f.fixture.requests.filter((entry) => entry.method === MODELS_METHOD).length;
    const allModels = f.runtime.getModels("devin"), allIDs = allModels.map((model) => model.id);
    const levelMaps = (models: readonly { id: string; thinkingLevelMap?: unknown }[]) => [...models].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map((model) => [model.id, model.thinkingLevelMap]);
    const expected = allModels.filter((model) => model.id === FUSION_MODEL_ID || Object.values(model.thinkingLevelMap ?? {}).some((uid) => typeof uid === "string" && recommendedUIDs.has(uid)));
    const hidden = allModels.find((model) => !expected.includes(model))!;
    assert.ok(recommendedUIDs.size > 0 && hidden);
    const before = catalogRequests();
    await session.setModel(hidden);
    const leadsBefore = f.provider().getFusionChoices()!.leads.length;
    await session.prompt(`/${DEVIN_COMMAND_NAME} recommended on`);
    assert.deepEqual(f.devinSettings.read(), { recommendedOnly: true, showUsageStatus: false });
    // Recommended groups stay groups with the default list's level mappings, so `/thinking` still picks the recommended UID.
    assert.deepEqual(levelMaps(f.runtime.getModels("devin")), levelMaps(expected));
    assert.deepEqual(levelMaps(f.runtime.getAvailableSnapshot().filter((model) => model.provider === "devin")), levelMaps(expected));
    // The hidden current model stays in use for this session, and Fusion candidates ignore the filter.
    assert.equal(session.model?.id, hidden.id);
    assert.equal(f.provider().getFusionChoices()!.leads.length, leadsBefore);
    await session.prompt(`/${DEVIN_COMMAND_NAME} recommended off`);
    assert.deepEqual(f.runtime.getModels("devin").map((model) => model.id), allIDs);
    await session.prompt(`/${DEVIN_COMMAND_NAME} status on`);
    assert.deepEqual(f.devinSettings.read(), { recommendedOnly: false, showUsageStatus: true });
    // Bad arguments leave the saved value unchanged. The command sends no catalog or model request.
    for (const invalid of ["bogus", "recommended maybe", "status on extra"]) await session.prompt(`/${DEVIN_COMMAND_NAME} ${invalid}`);
    assert.deepEqual(f.devinSettings.read(), { recommendedOnly: false, showUsageStatus: true });
    assert.equal(catalogRequests(), before);
    assert.equal(f.chats().length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.dispose(); }
});

test("usage: the status line and details come only from the last account status and session records, and this package's key is used in the TUI only", async () => {
  const f = await fusionSession(() => streamResponse(finalFrames("ok")));
  try {
    const { session } = f;
    await session.setModel(f.runtime.getModel("devin", f.fusion.devin.fusion!.leadID)!);
    await session.prompt("hello");
    const provider = f.provider(), requestsBefore = f.fixture.requests.length;
    const account = provider.getAccountUsage()!;
    assert.deepEqual({ ...account, fetchedAtMs: typeof account.fetchedAtMs }, { billingStrategy: "BILLING_STRATEGY_QUOTA", dailyRemainingPercent: 100,
      weeklyRemainingPercent: 100, dailyResetAtMs: undefined, weeklyResetAtMs: undefined, fetchedAtMs: "number" });
    const usage = sessionUsage(f.manager.getBranch());
    assert.deepEqual(usage, { requests: 1, input: 3, output: 2, cacheRead: 0, cacheWrite: 0 });
    // Bars show the remaining quota in the same 10-cell format as the pi-ollama-cloud status. The color depends on the remaining amount.
    assert.equal(usageStatusText(account, usage), "devin day ▕██████████▏100% week ▕██████████▏100% · ↑3 ↓2");
    assert.equal(usageStatusText(account, usage, (tone, text) => `[${tone}]${text}`), "devin [success]day ▕██████████▏100% [success]week ▕██████████▏100% · ↑3 ↓2");
    assert.equal(usageStatusText(undefined, usage), "devin · ↑3 ↓2");
    assert.deepEqual([progressBar(98), progressBar(0), progressBar(150), progressBar(12.5)], ["▕█████████░▏", "▕░░░░░░░░░░▏", "▕██████████▏", "▕█░░░░░░░░░▏"]);
    assert.deepEqual([remainingTone(20), remainingTone(40), remainingTone(41)], ["error", "warning", "success"]);
    const report = usageReport(account, usage, provider.lifecycle.budget(), account.fetchedAtMs + 5 * 60_000).map((line) => line.text);
    assert.match(report[0], /^Account quota · fetched \d\d\/\d\d \d\d:\d\d \(5m ago\) · not live$/);
    assert.deepEqual(report.slice(1), ["  Daily  ▕██████████▏ 100% left · reset time unknown", "  Weekly ▕██████████▏ 100% left · reset time unknown",
      "This session · lead conversation (sidekick excluded)", "  1 request · input 3 · output 2 · cache read 0 · cache write 0", "Run budget · last run", "  ▕█░░░░░░░░░▏ 1/8 model calls used"]);
    const tones = usageReport(account, usage, { used: 8, limit: 8, isActive: true }, account.fetchedAtMs).map((line) => line.tone ?? null);
    assert.deepEqual(tones, [null, "success", "success", null, null, null, "error"]);
    // The status line is written only in the TUI and only with the toggle on. Off clears only this package's key.
    const statuses: [string, string | undefined][] = [];
    const context = (mode: string) => ({ mode, ui: { theme: { fg: (tone: string, text: string) => `[${tone}]${text}` },
      setStatus: (key: string, text: string | undefined) => { statuses.push([key, text]); } }, sessionManager: f.manager }) as never;
    updateUsageStatus(context("tui"), provider, f.devinSettings);
    f.devinSettings.write({ ...DEFAULT_PREFERENCES, showUsageStatus: true });
    updateUsageStatus(context("tui"), provider, f.devinSettings);
    updateUsageStatus(context("rpc"), provider, f.devinSettings);
    assert.deepEqual(statuses, [[USAGE_STATUS_KEY, undefined], [USAGE_STATUS_KEY, "devin [success]day ▕██████████▏100% [success]week ▕██████████▏100% · ↑3 ↓2"]]);
    assert.equal(f.fixture.requests.length, requestsBefore);
    // Display strings contain no tokens or account identifiers.
    assert.equal([...report, ...statuses.map(([, text]) => text ?? "")].some((text) => text.includes(providerCredential.sessionToken) || text.includes("offline-user-id")), false);
    // Accounts not billed by quota show no credits. Abbreviations and relative times follow the Pi display rules.
    assert.match(usageReport({ billingStrategy: "BILLING_STRATEGY_CREDITS", fetchedAtMs: 0 }, usage, { used: 0, limit: 8, isActive: true }, 0)[1].text, /Not a quota-billed account \(BILLING_STRATEGY_CREDITS\)/);
    assert.deepEqual([formatTokens(999), formatTokens(1234), formatTokens(12_345), formatTokens(1_234_567)], ["999", "1.2k", "12k", "1.2M"]);
    assert.deepEqual([relativeTime(0, 20_000), relativeTime(20_000, 0), relativeTime(90 * 60_000, 0), relativeTime(3 * 86_400_000, 0), relativeTime(0, 2 * 60_000)],
      ["just now", "soon", "in 1h 30m", "in 3d", "2m ago"]);
    assert.match(usageReport(account, usage, provider.lifecycle.budget(), account.fetchedAtMs + 10_000)[0].text, /fetched .+ \(just now\)/);
    assert.deepEqual(f.errors, []);
  } finally { await f.dispose(); }
});

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const KEYS = { up: "\x1b[A", down: "\x1b[B", tab: "\t", enter: "\r", escape: "\x1b", backspace: "\x7f", space: " " };

test("Fusion picker: switch between two columns with tab, choose with search, recommended and current marks, and save both with Enter", () => {
  const choices = {
    leads: [{ id: "family:a", name: "Alpha" }, { id: "family:b", name: "Beta", recommended: true as const }, { id: "family:c", name: "Gamma" }],
    sidekicks: [{ id: "uid:x-medium", name: "X Medium", groupName: "X", level: "medium" as const },
      { id: "uid:x-high", name: "X High", groupName: "X", level: "high" as const, recommended: true as const }],
  };
  const results: unknown[] = [];
  let renders = 0;
  const picker = (current = { leadID: "family:c", sidekickID: "uid:x-medium" }) => new FusionPicker({ choices, current, theme: plainTheme,
    requestRender: () => { renders++; }, done: (value) => { results.push(value); } });
  const first = picker();
  const screen = first.render(80);
  assert.equal(screen[1], "Current: Gamma + X Medium");
  assert.ok(screen.every((line) => visibleWidth(line) <= 80));
  // Recommended items come first and the cursor (›) sits on the current choice (●).
  assert.match(screen[3], /^▸ LEAD 3\/3 \(type to search\)\s+│ {3}SIDEKICK 2\/2\s*$/);
  const rows = screen.slice(4, 7).map((line) => line.split(" │ ")[0].trimEnd());
  assert.deepEqual(rows, ["  ★ Beta", "    Alpha", "›●  Gamma"]);
  first.handleInput(KEYS.down); // Wraps from the last item to the first.
  first.handleInput(KEYS.tab);
  first.handleInput(KEYS.up);
  assert.equal(first.render(80).at(-2), "Selected: Beta + X High");
  first.handleInput(KEYS.enter);
  assert.deepEqual(results, [{ leadID: "family:b", sidekickID: "uid:x-high" }]);
  assert.ok(renders >= 3);
  // Search: if the selection disappears it moves to the first match, and esc first clears only the search.
  const search = picker();
  for (const key of "alp") search.handleInput(key);
  assert.match(search.render(80)[3], /LEAD 1\/3 search: alp/);
  search.handleInput(KEYS.escape);
  assert.equal(results.length, 1);
  for (const key of "zzz") search.handleInput(key);
  search.handleInput(KEYS.enter);
  assert.equal(results.length, 1);
  assert.match(search.render(80).at(-1)!, /Pick a model in the lead column/);
  assert.match(search.render(80)[4], /no matching models/);
  for (let index = 0; index < 3; index++) search.handleInput(KEYS.backspace);
  search.handleInput(KEYS.escape);
  assert.deepEqual(results.at(-1), undefined);
  assert.equal(results.length, 2);
  // A narrow screen draws only the focused column within the width, and says so when no pair is saved.
  const narrow = new FusionPicker({ choices, current: undefined, theme: plainTheme, requestRender: () => {}, done: () => {} }).render(40);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 40));
  assert.equal(narrow[1], "Current: no saved pair");
  assert.match(narrow[3], /^\[LEAD\] SIDEKICK$/);
});

test("/devin screen: shows usage details and toggles, saves on every toggle and reverts on failure", async () => {
  const changes: unknown[] = [];
  let isFailing = false, closed = 0;
  const panel = new DevinPanel({ theme: plainTheme, report: () => [{ text: "Account quota · not received yet", isHeading: true }],
    preferences: { recommendedOnly: false, showUsageStatus: false },
    onChange: async (next) => { if (isFailing) throw new Error("disk full"); changes.push(next); },
    requestRender: () => {}, done: () => { closed++; } });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  assert.ok(panel.render(70).includes("Account quota · not received yet"));
  panel.handleInput(KEYS.space); await settle();
  panel.handleInput(KEYS.down); panel.handleInput(KEYS.enter); await settle();
  assert.deepEqual(changes, [{ recommendedOnly: true, showUsageStatus: false }, { recommendedOnly: true, showUsageStatus: true }]);
  assert.ok(panel.render(70).some((line) => line.startsWith("› [x] Usage in status line")));
  isFailing = true;
  panel.handleInput(KEYS.space); await settle();
  const screen = panel.render(70);
  assert.ok(screen.some((line) => line.startsWith("› [x] Usage in status line")));
  assert.match(screen.at(-1)!, /Could not save: disk full/);
  assert.ok(screen.every((line) => visibleWidth(line) <= 70));
  panel.handleInput(KEYS.escape);
  assert.equal(closed, 1);
});

test("/devin global store: corrupt or malformed files read as defaults and are not overwritten; writes use schemaVersion 1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-settings-"));
  try {
    const path = devinSettingsPath(join(directory, "agent"));
    assert.equal(path, join(directory, "agent", "pi-devin", "settings.json"));
    const store = fileDevinSettings(path);
    assert.deepEqual(store.read(), DEFAULT_PREFERENCES);
    store.write({ recommendedOnly: true, showUsageStatus: false });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { schemaVersion: 1, recommendedOnly: true, showUsageStatus: false });
    assert.deepEqual(fileDevinSettings(path).read(), { recommendedOnly: true, showUsageStatus: false });
    for (const invalid of ["{broken", JSON.stringify({ schemaVersion: 2, recommendedOnly: true, showUsageStatus: true }), JSON.stringify({ schemaVersion: 1, recommendedOnly: "yes", showUsageStatus: true })]) {
      await writeFile(path, invalid);
      assert.deepEqual(store.read(), DEFAULT_PREFERENCES);
      assert.equal(await readFile(path, "utf8"), invalid);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("/devin: when the list refresh fails after saving, the saved value stays and only a warning is shown", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  const settings = memoryDevinSettings();
  let rebuilds = 0;
  const provider = { rebuildModels: () => { rebuilds++; }, getModels: () => [], getAccountUsage: () => undefined,
    lifecycle: { budget: () => ({ used: 0, limit: 8, isActive: false }) } };
  registerDevinCommand({ registerCommand: (name: string, definition: never) => { commands.set(name, definition); } } as never, provider as never, settings);
  const notes: [string, string][] = [];
  const ctx = { mode: "rpc", hasUI: true, model: undefined, sessionManager: { getBranch: () => [] },
    ui: { notify: (message: string, type: string) => { notes.push([type, message]); } },
    modelRegistry: { refresh: async () => { throw new Error("registry busy"); } } } as never;
  await commands.get(DEVIN_COMMAND_NAME)!.handler("recommended on", ctx);
  assert.deepEqual(settings.read(), { recommendedOnly: true, showUsageStatus: false });
  assert.equal(rebuilds, 1);
  assert.deepEqual(notes.map(([type]) => type), ["warning", "info"]);
  assert.match(notes[0][1], /Settings were saved, but the model list could not be rebuilt: registry busy/);
});
