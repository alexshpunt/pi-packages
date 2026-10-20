import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager, type CreateAgentSessionRuntimeFactory, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDevinExtension } from "../src/pi/extension.ts";
import type { DevinProvider } from "../src/pi/provider.ts";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import type { JsonObject } from "../src/core/types.ts";
import { finalFrames, statusResponse, streamResponse } from "./helpers.ts";
import { providerFixture, providerHostCredential } from "./provider-fixture.ts";

async function runtimeFixture(options: Parameters<typeof providerFixture>[0] & {
  settings?: Parameters<typeof SettingsManager.inMemory>[0]; seed?: (manager: SessionManager, modelID: string) => void; mode?: Parameters<AgentSession["bindExtensions"]>[0]["mode"];
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-runtime-"));
  const fixture = await providerFixture(options); fixture.provider.shutdown();
  const credentials = new InMemoryCredentialStore(), modelsStore = new InMemoryModelsStore();
  await credentials.modify("devin", async () => providerHostCredential);
  const registrations: { provider: DevinProvider; ready: Promise<void> }[] = [], errors: string[] = [], events: string[] = [];
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore, refreshOnCreate: false, allowModelNetwork: false });
    const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "never", enableInstallTelemetry: false, cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false }, ...options.settings });
    const services = await createAgentSessionServices({ cwd, agentDir: join(directory, "agent"), modelRuntime, settingsManager,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Fixture only", extensionFactories: [(pi) => {
        const provider = registerDevinExtension(pi, fixture.dependencies);
        let ready!: () => void;
        registrations.push({ provider, ready: new Promise<void>((resolve) => { ready = resolve; }) });
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
  assert.equal(refreshed.aborted, false); assert.equal(refreshed.errors.size, 0);
  await runtime.session.setModel(runtime.session.modelRuntime.getModel("devin", fixture.model.id)!);
  return { ...fixture, runtime, credentials, errors, events, registrations,
    current: () => registrations.at(-1)!.provider,
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
    const originalFile = f.runtime.session.sessionFile!, original = f.current().lifecycle.snapshot();
    const originalProvider = f.current();
    const firstUser = f.runtime.session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!;
    assert.equal((await f.runtime.fork(firstUser.id, { position: "at" })).cancelled, false);
    await f.runtime.session.prompt("fork");
    assert.notEqual(f.current().lifecycle.snapshot().cascadeId, original.cascadeId);
    assert.notEqual(f.current(), originalProvider);
    assert.equal((await f.runtime.switchSession(originalFile)).cancelled, false);
    await f.runtime.session.prompt("resumed");
    assert.equal(f.current().lifecycle.snapshot().cascadeId, original.cascadeId);
    assert.equal(f.current().lifecycle.snapshot().nextStepIndex, 3);
    const beforeReload = f.current(); await f.runtime.session.reload(); await f.registrations.at(-1)!.ready;
    assert.notEqual(f.current(), beforeReload);
    assert.equal(f.runtime.session.modelRuntime.getProviders().filter((provider) => provider.id === "devin").length, 1);
    await f.runtime.session.prompt("reloaded");
    assert.equal(f.current().lifecycle.snapshot().nextStepIndex, 4);
    const firstAnswer = f.runtime.session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant")!;
    assert.equal((await f.runtime.session.navigateTree(firstAnswer.id, { summarize: false })).cancelled, false);
    await f.runtime.session.prompt("tree");
    const tree = f.current().lifecycle.snapshot();
    assert.equal(tree.cascadeId, original.cascadeId); assert.notEqual(tree.trajectoryId, original.trajectoryId); assert.equal(tree.nextStepIndex, 1);
    const count = f.chatCalls();
    (status.userStatus as JsonObject).userId = "another-offline-user";
    await f.credentials.modify("devin", async () => ({ ...providerHostCredential, access: "another-fake-token" }));
    const refreshed = await f.runtime.session.modelRuntime.refresh({ providers: ["devin"], allowNetwork: true, force: true }); assert.equal(refreshed.errors.size, 0);
    await f.runtime.session.setModel(f.runtime.session.modelRuntime.getModel("devin", f.model.id)!);
    await f.runtime.session.prompt("must not share history");
    assert.equal(f.chatCalls(), count);
    const last = f.runtime.session.messages.at(-1) as AssistantMessage;
    assert.equal(last.stopReason, "error"); assert.match(last.errorMessage!, /different Devin account/);
    await f.runtime.newSession(); await f.runtime.session.prompt("fresh account session");
    assert.equal(f.chatCalls(), count + 1);
    assert.deepEqual(f.errors, []);
    assert.ok(f.events.includes("shutdown:reload"));
  } finally { await f.close(); }
});

for (const timeoutMs of [undefined, 5000]) test(`public Pi timeout ${timeoutMs ?? 300000}ms applies to the final HTTP signal`, async (context) => {
  const expected = timeoutMs ?? 300000;
  const f = await runtimeFixture({ settings: { retry: { enabled: false, ...(timeoutMs ? { provider: { timeoutMs } } : {}) } }, chat: (request) => {
    context.mock.timers.tick(expected - 1); assert.equal(request.signal.aborted, false);
    context.mock.timers.tick(1); assert.equal(request.signal.aborted, true);
    return new Promise(() => {});
  } });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await f.runtime.session.prompt("timeout");
    const result = f.runtime.session.messages.at(-1) as AssistantMessage;
    assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, new RegExp(String(expected))); assert.equal(f.chatCalls(), 1);
  } finally { context.mock.timers.reset(); await f.close(); }
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
    assert.equal(requests.length, 3, JSON.stringify({ events: f.events, contextWindow: f.runtime.session.model?.contextWindow, last: f.runtime.session.messages.at(-1) }));
    assert.equal(requests[0].headers.get("connect-content-encoding"), "gzip"); assert.equal(requests[1].headers.get("connect-content-encoding"), null);
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.equal(requests[0].body.executionId, undefined); assert.ok(requests[2].body.executionId);
    assert.equal(new Set(requests.map((request) => request.body.cascadeId)).size, 1);
    assert.equal(f.current().lifecycle.snapshot().execution!.used, 3);
    assert.ok(f.events.indexOf("compact:threshold") < f.events.indexOf("before"));
    assert.equal(f.runtime.session.getLastAssistantText(), "summary or answer");
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("overflow auto-compaction uses the same run budget; manual compaction gets its own", async () => {
  const f = await runtimeFixture({ seed: (manager, modelID) => seed(manager, modelID, 10, "old conversation ".repeat(400)), settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 0 } },
    chat: (_request, index) => index === 1 ? Response.json({ message: "maximum context length is 10000 tokens" }, { status: 400 }) : streamResponse(finalFrames("summary or answer")),
  });
  try {
    await f.runtime.session.setModel({ ...f.runtime.session.model!, contextWindow: 10000 });
    await f.runtime.session.prompt("overflow");
    assert.ok(f.events.includes("compact:overflow"), JSON.stringify({ events: f.events, contextWindow: f.runtime.session.model?.contextWindow, last: f.runtime.session.messages.at(-1) }));
    const requests = f.requests.filter((request) => request.method === CHAT_METHOD);
    assert.deepEqual(requests.map((request) => request.body.executionId === undefined), [false, true, true, false]);
    assert.equal(requests[0].body.executionId, requests[3].body.executionId);
    const original = f.current().lifecycle.snapshot().execution!; assert.equal(original.used, 4); assert.equal(original.settled, true);
    await f.runtime.session.prompt("more history");
    await f.runtime.session.compact("manual summary");
    const manual = f.current().lifecycle.snapshot().execution!;
    assert.equal(manual.used, 2); assert.equal(manual.settled, true); assert.notEqual(manual.id, original.id);
    assert.ok(f.events.includes("compact:manual")); assert.deepEqual(f.errors, []);
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
    assert.equal(f.chatCalls(), 2);
    const result = f.runtime.session.messages.at(-1) as AssistantMessage;
    assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /all 2 Devin model HTTP requests/);
    assert.equal(f.current().lifecycle.snapshot().execution!.used, 2);
  } finally { await f.close(); }
});

for (const mode of ["tui", "json", "rpc"] as const) test(`public SDK ${mode} binding ends the response and does not wait for login input on unauthenticated requests`, async () => {
  const f = await runtimeFixture({ mode });
  try {
    await f.runtime.session.prompt("mode check");
    assert.equal((f.runtime.session.messages.at(-1) as AssistantMessage).stopReason, "stop");
    await f.runtime.session.modelRuntime.logout("devin");
    const before = f.requests.length;
    const result = await f.runtime.session.modelRuntime.completeSimple(f.model, { messages: [{ role: "user", content: "no credentials", timestamp: 1 }] });
    assert.equal(result.stopReason, "error"); assert.equal(f.requests.length, before);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("cache warming: Devin models expose no TTL, so no warming request is made in streaming or idle mode", async () => {
  for (const cacheWarming of ["streaming", "idle"] as const) {
    const f = await runtimeFixture({ settings: { cacheWarming } });
    try {
      await f.runtime.session.prompt("warm?");
      const chats = f.requests.filter((request) => request.method === CHAT_METHOD).length;
      assert.equal(chats, 1);
      const status = f.runtime.session.cacheWarmingStatus!;
      assert.deepEqual([status.state, status.state === "inactive" ? status.reason : ""], ["inactive", "cache lifetime unavailable"]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(f.requests.filter((request) => request.method === CHAT_METHOD).length, chats);
    } finally { await f.close(); }
  }
});

test("the cache_warming_decision handler stops warming only for Devin models", () => {
  const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
  const pi = { registerProvider: () => {}, registerTool: () => {}, registerCommand: () => {}, getActiveTools: () => [], setActiveTools: () => {},
    on: (name: string, handler: (event: unknown, context: unknown) => unknown) => { handlers.set(name, handler); return () => {}; } } as unknown as ExtensionAPI;
  const provider = registerDevinExtension(pi);
  try {
    const decide = handlers.get("cache_warming_decision")!;
    const event = { type: "cache_warming_decision", action: "warm", warmCost: 0, missCost: 0, continuationProbability: 1 };
    assert.deepEqual(decide(event, { model: { provider: "devin" } }), { action: "stop" });
    assert.equal(decide(event, { model: { provider: "anthropic" } }), undefined);
  } finally { provider.shutdown(); }
});
