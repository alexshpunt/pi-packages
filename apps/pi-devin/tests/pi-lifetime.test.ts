import { expect, test } from "vitest";
import { normalizeContext, type AssistantMessage, type AssistantMessageEventStream, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import type { JsonObject } from "../src/core/types.ts";
import { attachSession } from "../src/pi/app/session.ts";
import { DEVIN_STATE_ENTRY } from "../src/pi/features/runs/state.ts";
import type { DevinSessionState } from "../src/pi/features/runs/types.ts";
import { makeTestProvider, type TestProvider } from "./extension-harness.ts";
import { finalFrames, MODELS_METHOD, STATUS_METHOD, statusResponse, streamResponse, unaryResponse } from "./helpers.ts";
import { extendedCacheCatalog, providerCatalog, providerCredential, providerHostCredential, TEAM_METHOD } from "./provider-fixture.ts";

const prompt = () => normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const options = { apiKey: providerCredential.sessionToken, reasoning: "medium" as const };
async function settle(stream: AssistantMessageEventStream): Promise<AssistantMessage> {
  for await (const _event of stream) { /* drain */ }
  return stream.result();
}
const waitUntil = async (predicate: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 500 && !predicate(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate(), label).toBeTruthy();
};
/** Pi's `session_start` for a new in-memory session. */
const startSession = (opened: TestProvider) => {
  const manager = SessionManager.inMemory();
  opened.runtime.runSync(attachSession({
    getSessionId: () => manager.getSessionId(), getBranch: () => manager.getBranch(),
    append: (data: DevinSessionState) => { manager.appendCustomEntry(DEVIN_STATE_ENTRY, data); },
  }));
};

interface Gate { promise: Promise<void>; open(): void }
function gate(): Gate {
  let open!: () => void;
  return { promise: new Promise<void>((resolve) => { open = resolve; }), open: () => open() };
}

/** A provider over a fake server whose chat and catalog answers the test controls. */
function serve(answers: { chat?: (signal: AbortSignal) => Promise<Response>; catalog?: () => Promise<JsonObject> } = {}) {
  let chats = 0, catalogs = 0;
  const opened = makeTestProvider({ fetch: async (url, init) => {
    const method = new URL(String(url)).pathname.slice(1);
    if (method === STATUS_METHOD) return unaryResponse(method, statusResponse());
    if (method === TEAM_METHOD) return unaryResponse(method, {});
    if (method === MODELS_METHOD) { catalogs++; return unaryResponse(method, await (answers.catalog?.() ?? Promise.resolve(providerCatalog))); }
    if (method !== CHAT_METHOD) throw new Error(`Unexpected fixture RPC: ${method}`);
    chats++;
    return answers.chat ? answers.chat(init!.signal!) : streamResponse(finalFrames());
  } });
  const published: unknown[] = [];
  const refresh = (signal = new AbortController().signal) => opened.provider.refreshModels({
    credential: providerHostCredential, allowNetwork: true, force: true, signal,
    publish: async (publication) => { published.push(publication); publication.update?.(); return true; },
  } satisfies RefreshModelsContext);
  const model = () => opened.provider.getModels().find((model) => model.id !== "fusion")!;
  return { ...opened, refresh, model, published, chats: () => chats, catalogs: () => catalogs };
}

/** A chat request that never answers and fails only when its signal aborts. */
const hanging = (signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

test("two extension instances in one process keep separate lifetimes: shutting one down stops only its own request", async () => {
  const released = gate();
  const first = serve({ chat: hanging });
  const second = serve({ chat: async () => { await released.promise; return streamResponse(finalFrames("second done")); } });
  try {
    await first.refresh(); await second.refresh();
    const firstResult = settle(first.provider.streamSimple(first.model(), prompt(), options));
    const secondResult = settle(second.provider.streamSimple(second.model(), prompt(), options));
    await waitUntil(() => first.chats() === 1 && second.chats() === 1, "both requests reach the server");
    first.shutdown();
    const stopped = await firstResult;
    expect([stopped.stopReason, stopped.errorMessage]).toStrictEqual(["aborted", "The Devin provider shut down."]);
    released.open();
    const completed = await secondResult;
    expect(completed.stopReason).toBe("stop");
    expect(completed.content.map((part) => part.type === "text" ? part.text : part.type)).toStrictEqual(["second done"]);
    // The other instance's catalog and lifetime are untouched.
    expect(second.provider.getModels().length).toBeGreaterThan(0);
    await second.refresh();
    expect(second.catalogs()).toBe(2);
  } finally { first.shutdown(); second.shutdown(); }
});

test("after shutdown the same provider object refuses work until the next session_start, then serves it again", async () => {
  const opened = serve();
  try {
    await opened.refresh();
    const listed = opened.provider.getModels().map((model) => model.id);
    opened.shutdown();
    // Shutdown keeps the list Pi already has; only new work is refused.
    expect(opened.provider.getModels().map((model) => model.id)).toStrictEqual(listed);
    const refused = await settle(opened.provider.streamSimple(opened.model(), prompt(), options));
    expect([refused.stopReason, refused.errorMessage]).toStrictEqual(["aborted", "The Devin provider shut down."]);
    await expect(opened.refresh()).rejects.toThrow("The Devin provider shut down.");
    expect(opened.chats()).toBe(0); expect(opened.catalogs()).toBe(1);
    startSession(opened);
    const served = await settle(opened.provider.streamSimple(opened.model(), prompt(), options));
    expect(served.stopReason).toBe("stop");
    await opened.refresh();
    expect(opened.chats()).toBe(1); expect(opened.catalogs()).toBe(2);
    // A second shutdown/session_start cycle works the same way on the same runtime.
    opened.shutdown(); startSession(opened);
    expect((await settle(opened.provider.streamSimple(opened.model(), prompt(), options))).stopReason).toBe("stop");
  } finally { opened.shutdown(); }
});

test("a catalog refresh still running at shutdown never changes the list, even when its answer arrives after the next session_start", async () => {
  const late = gate();
  let isFirst = true;
  const opened = serve({ catalog: async () => {
    if (isFirst) { isFirst = false; return providerCatalog; }
    await late.promise;
    return extendedCacheCatalog;
  } });
  try {
    await opened.refresh();
    const listed = opened.provider.getModels().map((model) => model.id), publications = opened.published.length;
    const pending = opened.refresh();
    await waitUntil(() => opened.catalogs() === 2, "the second catalog lookup reaches the server");
    opened.shutdown();
    await expect(pending).rejects.toThrow("The Devin provider shut down.");
    startSession(opened);
    late.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened.published.length).toBe(publications);
    expect(opened.provider.getModels().map((model) => model.id)).toStrictEqual(listed);
  } finally { opened.shutdown(); }
});

test("a request that outlives the provider call still lets timers and input run during a long response burst", async () => {
  // One response chunk with many frames, processed as one synchronous burst.
  const frames = [
    ...Array.from({ length: 4000 }, (_, index) => ({ messageId: "bot-response", deltaText: index % 2 ? "a" : "b" })),
    { stopReason: "STOP_REASON_STOP_PATTERN" }, { usage: { inputTokens: 3, outputTokens: 2 } },
  ];
  const opened = serve({ chat: async () => streamResponse(frames) });
  try {
    await opened.refresh();
    const stream = opened.provider.streamSimple(opened.model(), prompt(), options);
    let events = 0, eventsWhenMacrotaskRan = -1;
    for await (const event of stream) {
      events++;
      if (event.type === "text_delta" && eventsWhenMacrotaskRan === -1) {
        eventsWhenMacrotaskRan = 0;
        setImmediate(() => { eventsWhenMacrotaskRan = events; });
      }
    }
    expect((await stream.result()).stopReason).toBe("stop");
    // The request yields to the event loop as Effect's default scheduler does, rather than holding it until the burst ends.
    expect(eventsWhenMacrotaskRan).toBeGreaterThan(0);
    expect(eventsWhenMacrotaskRan).toBeLessThan(events);
  } finally { opened.shutdown(); }
});
