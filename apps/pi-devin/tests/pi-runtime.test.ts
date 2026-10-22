import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { InMemoryCredentialStore, InMemoryModelsStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager, type CreateAgentSessionRuntimeFactory, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTestExtension, type TestProvider } from "./extension-harness.ts";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import type { JsonObject } from "../src/core/types.ts";
import { finalFrames, runSync, statusResponse, streamResponse } from "./helpers.ts";
import { providerFixture, providerHostCredential } from "./provider-fixture.ts";

async function runtimeFixture(options: Parameters<typeof providerFixture>[0] & {
  settings?: Parameters<typeof SettingsManager.inMemory>[0]; seed?: (manager: SessionManager, modelID: string) => void; mode?: Parameters<AgentSession["bindExtensions"]>[0]["mode"];
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
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: fixture.model, thinkingLevel: "high", noTools: "all" });
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

test("threshold compaction, the compression send fallback and the follow-up inference share one budget", async () => {
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
    expect(runSync(f.runs().snapshot).execution!.used).toBe(3);
    expect(f.events.indexOf("compact:threshold") < f.events.indexOf("before")).toBeTruthy();
    expect(f.runtime.session.getLastAssistantText()).toBe("summary or answer");
    expect(f.errors).toStrictEqual([]);
  } finally { await f.close(); }
});

test("overflow auto-compaction uses the same run budget; manual compaction gets its own", async () => {
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
    const original = runSync(f.runs().snapshot).execution!; expect(original.used).toBe(4); expect(original.settled).toBe(true);
    await f.runtime.session.prompt("more history");
    await f.runtime.session.compact("manual summary");
    const manual = runSync(f.runs().snapshot).execution!;
    expect(manual.used).toBe(2); expect(manual.settled).toBe(true); expect(manual.id).not.toBe(original.id);
    expect(f.events.includes("compact:manual")).toBeTruthy(); expect(f.errors).toStrictEqual([]);
  } finally { await f.close(); }
});

test("when a pre-start compaction fallback uses up the budget, the main inference is not sent", async () => {
  const f = await runtimeFixture({ maxModelCalls: 2,
    seed: (manager, modelID) => seed(manager, modelID, 9500, "long seed ".repeat(2000)),
    settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 0 } },
    chat: (_request, index) => index === 1 ? Response.json({}, { status: 503 }) : streamResponse(finalFrames("summary")),
  });
  try {
    await f.runtime.session.setModel({ ...f.runtime.session.model!, contextWindow: 10000 });
    await f.runtime.session.prompt("cannot bypass budget");
    expect(f.chatCalls()).toBe(2);
    const result = f.runtime.session.messages.at(-1) as AssistantMessage;
    expect(result.stopReason).toBe("error"); expect(result.errorMessage!).toMatch(/all 2 Devin model HTTP requests/);
    expect(runSync(f.runs().snapshot).execution!.used).toBe(2);
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
