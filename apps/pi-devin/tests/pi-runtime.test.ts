import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { InMemoryCredentialStore, InMemoryModelsStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager, type CreateAgentSessionRuntimeFactory, type AgentSession, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerTestExtension, type TestProvider } from "./extension-harness.ts";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import type { JsonObject } from "../src/core/types.ts";
import { encodeResponse, errorStreamResponse, finalFrames, frameBytes, runSync, statusResponse, streamResponse } from "./helpers.ts";
import { providerFixture, providerHostCredential } from "./provider-fixture.ts";

async function runtimeFixture(options: Parameters<typeof providerFixture>[0] & {
  settings?: Parameters<typeof SettingsManager.inMemory>[0]; seed?: (manager: SessionManager, modelID: string) => void; mode?: Parameters<AgentSession["bindExtensions"]>[0]["mode"];
  /** Tools the session may call; without them the session has none. */
  tools?: ToolDefinition[];
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-runtime-"));
  const fixture = await providerFixture(options); fixture.shutdown();
  const credentials = new InMemoryCredentialStore(), modelsStore = new InMemoryModelsStore();
  await credentials.modify("devin", async () => providerHostCredential);
  const registrations: { extension: TestProvider; ready: Promise<void> }[] = [], errors: string[] = [], events: string[] = [];
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore, refreshOnCreate: false, allowModelNetwork: false });
    const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "never", enableInstallTelemetry: false, cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false }, ...options.settings });
    const services = await createAgentSessionServices({ cwd, agentDir: join(directory, "agent"), modelRuntime, settingsManager,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Fixture only", extensionFactories: [(pi) => {
        const extension = registerTestExtension(pi, fixture.dependencies), { provider } = extension;
        let ready!: () => void;
        registrations.push({ extension, ready: new Promise<void>((resolve) => { ready = resolve; }) });
        const refresh = provider.refreshModels;
        provider.refreshModels = async (context) => { await refresh(context); if (!context.allowNetwork) ready(); };
        pi.on("session_before_compact", (event) => { events.push(`compact:${event.reason}`); });
        pi.on("before_agent_start", () => { events.push("before"); });
        pi.on("agent_settled", () => { events.push("settled"); });
        pi.on("session_shutdown", (event) => { events.push(`shutdown:${event.reason}`); });
      }] },
    });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: fixture.model, thinkingLevel: "high",
      ...(options.tools ? { customTools: options.tools, tools: options.tools.map((tool) => tool.name) } : { noTools: "all" as const }) });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const manager = SessionManager.create(directory, join(directory, "sessions")); options.seed?.(manager, fixture.model.id);
  const runtime = await createAgentSessionRuntime(factory, { cwd: directory, agentDir: join(directory, "agent"), sessionManager: manager });
  const bind = async (session: AgentSession) => {
    await session.bindExtensions({ mode: options.mode ?? "print", onError: (error) => { errors.push(error.error); } });
    await registrations.at(-1)!.ready;
  };
  runtime.setRebindSession(bind); await bind(runtime.session);
  const refreshed = await runtime.session.modelRuntime.refresh({ providers: ["devin"], allowNetwork: true, force: true });
  expect(refreshed.aborted).toBe(false); expect(refreshed.errors.size).toBe(0);
  await runtime.session.setModel(runtime.session.modelRuntime.getModel("devin", fixture.model.id)!);
  return { ...fixture, runtime, credentials, errors, events, registrations,
    current: () => registrations.at(-1)!.extension.provider,
    runs: () => registrations.at(-1)!.extension.runs,
    close: async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); },
  };
}

function seed(manager: SessionManager, modelID: string, tokens = 9500, text = "seed") {
  manager.appendMessage({ role: "user", content: text, timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "seed answer" }], api: "devin-connect", provider: "devin", model: modelID, providerThinkingLevel: "swe-2-high",
    stopReason: "stop", timestamp: 2, usage: { input: tokens, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } satisfies AssistantMessage);
}

test("real session runtime fork/resume/reload/tree and account switch boundaries", async () => {
  const status = statusResponse(); const f = await runtimeFixture({ status });
  try {
    await f.runtime.session.prompt("first"); await f.runtime.session.prompt("second");
    const originalFile = f.runtime.session.sessionFile!, original = runSync(f.runs().snapshot);
    const originalProvider = f.current();
    const firstUser = f.runtime.session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!;
    expect((await f.runtime.fork(firstUser.id, { position: "at" })).cancelled).toBe(false);
    await f.runtime.session.prompt("fork");
    expect(runSync(f.runs().snapshot).cascadeId).not.toBe(original.cascadeId);
    expect(f.current()).not.toBe(originalProvider);
    expect((await f.runtime.switchSession(originalFile)).cancelled).toBe(false);
    await f.runtime.session.prompt("resumed");
    expect(runSync(f.runs().snapshot).cascadeId).toBe(original.cascadeId);
    expect(runSync(f.runs().snapshot).nextStepIndex).toBe(3);
    const beforeReload = f.current(); await f.runtime.session.reload(); await f.registrations.at(-1)!.ready;
    expect(f.current()).not.toBe(beforeReload);
    expect(f.runtime.session.modelRuntime.getProviders().filter((provider) => provider.id === "devin").length).toBe(1);
    await f.runtime.session.prompt("reloaded");
    expect(runSync(f.runs().snapshot).nextStepIndex).toBe(4);
    const firstAnswer = f.runtime.session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
    expect((await f.runtime.session.navigateTree(firstAnswer.id, { summarize: false })).cancelled).toBe(false);
    await f.runtime.session.prompt("tree");
    const tree = runSync(f.runs().snapshot);
    expect(tree.cascadeId).toBe(original.cascadeId); expect(tree.trajectoryId).not.toBe(original.trajectoryId); expect(tree.nextStepIndex).toBe(1);
    const count = f.chatCalls();
    (status.userStatus as JsonObject).userId = "another-offline-user";
    await f.credentials.modify("devin", async () => ({ ...providerHostCredential, access: "another-fake-token" }));
    const refreshed = await f.runtime.session.modelRuntime.refresh({ providers: ["devin"], allowNetwork: true, force: true }); expect(refreshed.errors.size).toBe(0);
    await f.runtime.session.setModel(f.runtime.session.modelRuntime.getModel("devin", f.model.id)!);
    await f.runtime.session.prompt("must not share history");
    expect(f.chatCalls()).toBe(count);
    const last = f.runtime.session.messages.at(-1) as AssistantMessage;
    expect(last.stopReason).toBe("error"); expect(last.errorMessage!).toMatch(/different Devin account/);
    await f.runtime.newSession(); await f.runtime.session.prompt("fresh account session");
    expect(f.chatCalls()).toBe(count + 1);
    expect(f.errors).toStrictEqual([]);
    expect(f.events.includes("shutdown:reload")).toBeTruthy();
  } finally { await f.close(); }
});

for (const timeoutMs of [undefined, 5000]) test(`public Pi timeout ${timeoutMs ?? 300000}ms applies to the final HTTP signal`, async (context) => {
  const expected = timeoutMs ?? 300000;
  const f = await runtimeFixture({ settings: { retry: { enabled: false, ...(timeoutMs ? { provider: { timeoutMs } } : {}) } }, chat: (request) => {
    vi.advanceTimersByTime(expected - 1); expect(request.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1); expect(request.signal.aborted).toBe(true);
    return new Promise(() => {});
  } });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await f.runtime.session.prompt("timeout");
    const result = f.runtime.session.messages.at(-1) as AssistantMessage;
    expect(result.stopReason).toBe("error"); expect(result.errorMessage!).toMatch(new RegExp(String(expected))); expect(f.chatCalls()).toBe(1);
  } finally { vi.useRealTimers(); await f.close(); }
});

test("threshold compaction, the compression send fallback and the follow-up inference share one run", async () => {
  const f = await runtimeFixture({ seed: (manager, modelID) => seed(manager, modelID, 9500, "long seed ".repeat(2000)),
    settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 0 } },
    chat: (_request, index) => index === 1 ? Response.json({ message: "fallback" }, { status: 503 }) : streamResponse(finalFrames("summary or answer")),
  });
  try {
    await f.runtime.session.setModel({ ...f.runtime.session.model!, contextWindow: 10000 });
    await f.runtime.session.prompt("next");
    const requests = f.requests.filter((request) => request.method === CHAT_METHOD);
    expect(requests.length, JSON.stringify({ events: f.events, contextWindow: f.runtime.session.model?.contextWindow, last: f.runtime.session.messages.at(-1) })).toBe(3);
    expect(requests[0].headers.get("connect-content-encoding")).toBe("gzip"); expect(requests[1].headers.get("connect-content-encoding")).toBe(null);
    expect(requests[0].body).toStrictEqual(requests[1].body);
    expect(requests[0].body.executionId).toBe(undefined); expect(requests[2].body.executionId).toBeTruthy();
    expect(new Set(requests.map((request) => request.body.cascadeId)).size).toBe(1);
    expect(f.events.indexOf("compact:threshold") < f.events.indexOf("before")).toBeTruthy();
    expect(f.runtime.session.getLastAssistantText()).toBe("summary or answer");
    expect(f.errors).toStrictEqual([]);
  } finally { await f.close(); }
});

test("overflow auto-compaction stays in the same run; manual compaction gets its own", async () => {
  const f = await runtimeFixture({ seed: (manager, modelID) => seed(manager, modelID, 10, "old conversation ".repeat(400)), settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 0 } },
    chat: (_request, index) => index === 1 ? Response.json({ message: "maximum context length is 10000 tokens" }, { status: 400 }) : streamResponse(finalFrames("summary or answer")),
  });
  try {
    await f.runtime.session.setModel({ ...f.runtime.session.model!, contextWindow: 10000 });
    await f.runtime.session.prompt("overflow");
    expect(f.events.includes("compact:overflow"), JSON.stringify({ events: f.events, contextWindow: f.runtime.session.model?.contextWindow, last: f.runtime.session.messages.at(-1) })).toBeTruthy();
    const requests = f.requests.filter((request) => request.method === CHAT_METHOD);
    expect(requests.map((request) => request.body.executionId === undefined)).toStrictEqual([false, true, true, false]);
    expect(requests[0].body.executionId).toBe(requests[3].body.executionId);
    const original = runSync(f.runs().snapshot).execution!; expect(original.settled).toBe(true);
    await f.runtime.session.prompt("more history");
    await f.runtime.session.compact("manual summary");
    const manual = runSync(f.runs().snapshot).execution!;
    expect(manual.settled).toBe(true); expect(manual.id).not.toBe(original.id);
    expect(f.events.includes("compact:manual")).toBeTruthy(); expect(f.errors).toStrictEqual([]);
  } finally { await f.close(); }
});

for (const mode of ["tui", "json", "rpc"] as const) test(`public SDK ${mode} binding ends the response and does not wait for login input on unauthenticated requests`, async () => {
  const f = await runtimeFixture({ mode });
  try {
    await f.runtime.session.prompt("mode check");
    expect((f.runtime.session.messages.at(-1) as AssistantMessage).stopReason).toBe("stop");
    await f.runtime.session.modelRuntime.logout("devin");
    const before = f.requests.length;
    const result = await f.runtime.session.modelRuntime.completeSimple(f.model, { messages: [{ role: "user", content: "no credentials", timestamp: 1 }] });
    expect(result.stopReason).toBe("error"); expect(f.requests.length).toBe(before);
    expect(f.errors).toStrictEqual([]);
  } finally { await f.close(); }
});

test("cache warming: Devin models expose no TTL, so no warming request is made in streaming or idle mode", async () => {
  for (const cacheWarming of ["streaming", "idle"] as const) {
    const f = await runtimeFixture({ settings: { cacheWarming } });
    try {
      await f.runtime.session.prompt("warm?");
      const chats = f.requests.filter((request) => request.method === CHAT_METHOD).length;
      expect(chats).toBe(1);
      const status = f.runtime.session.cacheWarmingStatus!;
      expect([status.state, status.state === "inactive" ? status.reason : ""]).toStrictEqual(["inactive", "cache lifetime unavailable"]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(f.requests.filter((request) => request.method === CHAT_METHOD).length).toBe(chats);
    } finally { await f.close(); }
  }
});

test("the cache_warming_decision handler stops warming only for Devin models", () => {
  const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
  const pi = { registerProvider: () => {}, registerTool: () => {}, registerCommand: () => {}, getActiveTools: () => [], setActiveTools: () => {},
    on: (name: string, handler: (event: unknown, context: unknown) => unknown) => { handlers.set(name, handler); return () => {}; } } as unknown as ExtensionAPI;
  const extension = registerTestExtension(pi);
  try {
    const decide = handlers.get("cache_warming_decision")!;
    const event = { type: "cache_warming_decision", action: "warm", warmCost: 0, missCost: 0, continuationProbability: 1 };
    expect(decide(event, { model: { provider: "devin" } })).toStrictEqual({ action: "stop" });
    expect(decide(event, { model: { provider: "anthropic" } })).toBe(undefined);
  } finally { extension.shutdown(); }
});

/** A tool that counts its runs, so a test can tell whether Pi executed a call. */
function countingTool() {
  const tool: ToolDefinition & { runs: number } = { name: "fixture_add", label: "Fixture", description: "Add two numbers", runs: 0,
    parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    execute: async (_id, args) => { tool.runs++; const value = args as { a: number; b: number }; return { content: [{ type: "text", text: String(value.a + value.b) }], details: {} }; },
  };
  return tool;
}

/** Frames sent one by one with a pause between them, as a server that keeps answering does. */
function pacedResponse(frames: JsonObject[], pauseMs: number, isEnded = true): Response {
  const chunks = [...frames.map((frame) => frameBytes(encodeResponse(frame))), ...(isEnded ? [frameBytes(Buffer.from("{}"), 2)] : [])];
  return new Response(new ReadableStream({ async start(controller) {
    for (const chunk of chunks) { controller.enqueue(new Uint8Array(chunk)); await new Promise((resolve) => setTimeout(resolve, pauseMs)); }
    if (isEnded) controller.close();
  } }), { headers: { "content-type": "application/connect+proto" } });
}

const toolResultsOf = (request: { body: JsonObject }) => (request.body.chatMessagePrompts as JsonObject[]).filter((message) => message.source === "CHAT_MESSAGE_SOURCE_TOOL");

test("Pi's provider retry count and transport preference do not stop Devin requests", async () => {
  const f = await runtimeFixture({ settings: { retry: { enabled: false, provider: { maxRetries: 2 } }, transport: "websocket" } });
  try {
    await f.runtime.session.prompt("preferences");
    expect(f.runtime.session.getLastAssistantText()).toBe("OK"); expect(f.chatCalls()).toBe(1); expect(f.errors).toStrictEqual([]);
  } finally { await f.close(); }
});

test("a stream that keeps sending data outlives the timeout, and one that goes quiet for the timeout fails", async () => {
  const frames = ["one ", "two ", "three ", "four", ""].map((deltaText, index) => index < 4 ? { deltaText } : { stopReason: "STOP_REASON_STOP_PATTERN" });
  const f = await runtimeFixture({ settings: { retry: { enabled: false, provider: { timeoutMs: 300 } } },
    chat: (_request, index) => index === 1 ? pacedResponse(frames, 150) : pacedResponse([{ deltaText: "partial" }], 0, false) });
  try {
    await f.runtime.session.prompt("long answer");
    expect(f.runtime.session.getLastAssistantText()).toBe("one two three four");
    await f.runtime.session.prompt("stalled answer");
    const stalled = f.runtime.session.messages.at(-1) as AssistantMessage;
    expect(stalled.stopReason).toBe("error"); expect(stalled.errorMessage!).toMatch(/no data for 300ms/);
  } finally { await f.close(); }
}, 10_000);

test("rate limits and server errors with an error body reach Pi's host retry, while quota errors are not retried", async () => {
  const failures = [
    () => Response.json({ code: "resource_exhausted", message: "slow down" }, { status: 429 }),
    () => Response.json({ code: "internal", message: "model failed" }, { status: 500 }),
    () => errorStreamResponse("internal", "model failed"),
    () => errorStreamResponse("resource_exhausted", "slow down"),
  ];
  for (const failure of failures) {
    const f = await runtimeFixture({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 } },
      chat: (_request, index) => index === 1 ? failure() : streamResponse(finalFrames("recovered")) });
    try {
      await f.runtime.session.prompt("retry");
      expect(f.runtime.session.getLastAssistantText()).toBe("recovered"); expect(f.chatCalls()).toBe(2);
    } finally { await f.close(); }
  }
  const quota = await runtimeFixture({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 } },
    chat: () => Response.json({ code: "resource_exhausted", message: "quota exceeded" }, { status: 429 }) });
  try {
    await quota.runtime.session.prompt("quota");
    const result = quota.runtime.session.messages.at(-1) as AssistantMessage;
    expect(result.stopReason).toBe("error"); expect(result.errorMessage!).toMatch(/quota exceeded/); expect(quota.chatCalls()).toBe(1);
  } finally { await quota.close(); }
});

test("calls cut off at the output limit and calls with invalid arguments are not run, and the model is asked to call again", async () => {
  const cases = [
    { frames: [{ deltaToolCalls: [{ id: "cut", name: "fixture_add", argumentsJson: '{"a":1,"b":2}' }] }, { stopReason: "STOP_REASON_MAX_TOKENS" }], expected: /output token limit/ },
    { frames: [{ deltaToolCalls: [{ id: "bad", name: "fixture_add", argumentsJson: '{"a":' }] }, { stopReason: "STOP_REASON_FUNCTION_CALL" }], expected: /Invalid arguments for tool "fixture_add"[\s\S]*Received arguments:\n\{"a":/ },
  ];
  for (const { frames, expected } of cases) {
    const tool = countingTool();
    const f = await runtimeFixture({ tools: [tool], chat: (_request, index) => index === 1 ? streamResponse(frames) : streamResponse(finalFrames("called again")) });
    try {
      await f.runtime.session.prompt("use the tool");
      expect(tool.runs).toBe(0); expect(f.chatCalls()).toBe(2); expect(f.errors).toStrictEqual([]);
      const [result] = toolResultsOf(f.requests.filter((request) => request.method === CHAT_METHOD)[1]);
      expect(result.toolResultIsError).toBe(true); expect(result.prompt as string).toMatch(expected);
      expect(f.runtime.session.getLastAssistantText()).toBe("called again");
    } finally { await f.close(); }
  }
});
