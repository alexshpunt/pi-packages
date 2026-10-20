import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatResponse } from "../scripts/cli/mock-transport.ts";
import type { AccountCredentialStore, StoredAccountKey } from "../src/accounts/credentials.ts";
import { createAccountRouter } from "../src/accounts/router.ts";
import { createSessionAccountBinding } from "../src/accounts/session.ts";
import { createAccountStateStore } from "../src/accounts/state.ts";
import { createAccountStreamSimple, type StreamSimpleFunction } from "../src/pi/account-stream.ts";
import type { UsageData } from "../src/usage/api.ts";

type Outcome = "ok" | "usage-limit" | "unauthorized" | "error-after-start" | "server-error";

const model = {
  id: "fixture:cloud",
  name: "Fixture",
  api: "openai-completions",
  provider: "ollama-cloud",
  baseUrl: "https://ollama.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
} as unknown as Model<Api>;
const context = { messages: [{ role: "user", content: "1+1", timestamp: 1 }] } as unknown as TranscriptContext;
const healthy: UsageData = { included: { balance_usd: 80, allowance_usd: 100 }, purchased: { balance_usd: 0 } };
const weeklyLimit = "429 you (fixture) have reached your weekly usage limit, upgrade for higher limits";

let directory: string;
let credentialsPath: string;

function message(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: stopReason === "stop" ? [{ type: "text", text: "2" }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 1,
  };
}

/** A provider stand-in whose response depends on the API key it receives. */
function scriptedDelegate(outcomes: Record<string, Outcome>) {
  const calls: SimpleStreamOptions[] = [];
  const delegate: StreamSimpleFunction = (_model, _context, options) => {
    calls.push(options ?? {});
    const stream = createAssistantMessageEventStream();
    const outcome = outcomes[options?.apiKey ?? ""] ?? "ok";
    queueMicrotask(() => {
      const partial = message("pending");
      if (outcome === "usage-limit" || outcome === "unauthorized" || outcome === "server-error") {
        const text =
          outcome === "usage-limit" ? weeklyLimit : outcome === "unauthorized" ? "401 invalid api key" : "500 boom";
        stream.push({ type: "error", reason: "error", error: message("error", text) });
        return;
      }
      stream.push({ type: "start", partial });
      if (outcome === "error-after-start") {
        stream.push({ type: "error", reason: "error", error: message("error", weeklyLimit) });
        return;
      }
      stream.push({ type: "text_start", contentIndex: 0, partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "2", partial });
      stream.push({ type: "text_end", contentIndex: 0, content: "2", partial });
      stream.push({ type: "done", reason: "stop", message: message("stop") });
    });
    return stream;
  };
  return { delegate, calls };
}

function services(entries: StoredAccountKey[]) {
  writeFileSync(credentialsPath, JSON.stringify(entries.map((entry) => entry.id)));
  const credentials: AccountCredentialStore = {
    path: credentialsPath,
    list: async () => entries.map((entry) => entry.id),
    resolve: async () => entries,
    add: async () => {},
    remove: async () => true,
  };
  const router = createAccountRouter({
    credentials,
    state: createAccountStateStore({ path: join(directory, "state.json") }),
    fetchBalance: async () => healthy,
  });
  const appendEntry = vi.fn();
  const binding = createSessionAccountBinding(appendEntry);
  binding.start({ getSessionId: () => "session-1", getEntries: () => [] });
  const notify = vi.fn();
  binding.setNotifier(notify);
  return { router, binding, notify, appendEntry };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ollama-account-stream-"));
  credentialsPath = join(directory, "accounts.json");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("account stream", () => {
  const twoAccounts = [{ id: "work", apiKey: "key-work" }];

  it("sends the session account's key and forwards the caller's options", async () => {
    const { router, binding } = services(twoAccounts);
    const { delegate, calls } = scriptedDelegate({});
    const stream = createAccountStreamSimple({ router, binding, delegate });
    const onPayload = vi.fn();
    const signal = new AbortController().signal;
    const headers = { "X-Fixture": "1" };
    const response = stream(model, context, {
      apiKey: "key-default",
      onPayload,
      signal,
      sessionId: "session-1",
      maxTokens: 321,
      headers,
    });
    const events = await collect(response);
    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect((await response.result()).stopReason).toBe("stop");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      apiKey: "key-default",
      onPayload,
      signal,
      sessionId: "session-1",
      maxTokens: 321,
    });
    expect(calls[0].headers).toBe(headers);
  });

  it("replaces a configured Authorization header with the selected account's key", async () => {
    const { router, binding } = services(twoAccounts);
    binding.bind("work");
    const { delegate, calls } = scriptedDelegate({});
    await collect(
      createAccountStreamSimple({ router, binding, delegate })(model, context, {
        apiKey: "key-default",
        headers: { authorization: "Bearer key-default", "X-Fixture": "1" },
      }),
    );
    expect(calls[0].apiKey).toBe("key-work");
    expect(calls[0].headers).toEqual({ authorization: "Bearer key-work", "X-Fixture": "1" });
  });

  it.each(["usage-limit", "unauthorized"] as const)(
    "resends a request rejected before it starts (%s) with the next account",
    async (outcome) => {
      const { router, binding, notify, appendEntry } = services(twoAccounts);
      const { delegate, calls } = scriptedDelegate({ "key-default": outcome });
      const response = createAccountStreamSimple({ router, binding, delegate })(model, context, {
        apiKey: "key-default",
      });
      const events = await collect(response);
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events[0].type).toBe("start");
      expect((await response.result()).stopReason).toBe("stop");
      expect(calls.map((call) => call.apiKey)).toEqual(["key-default", "key-work"]);
      expect(binding.accountId).toBe("work");
      expect(appendEntry.mock.calls.map((call) => call[1].accountId)).toEqual(["default", "work"]);
      expect(notify).toHaveBeenCalledOnce();
      await router.settle();
    },
  );

  it("passes errors after the response started and transient errors through unchanged", async () => {
    for (const outcome of ["error-after-start", "server-error"] as const) {
      const { router, binding } = services(twoAccounts);
      const { delegate, calls } = scriptedDelegate({ "key-default": outcome });
      const response = createAccountStreamSimple({ router, binding, delegate })(model, context, {
        apiKey: "key-default",
      });
      const events = await collect(response);
      expect(events.at(-1)?.type).toBe("error");
      expect(calls).toHaveLength(1);
      expect(binding.accountId).toBe("default");
      rmSync(join(directory, "state.json"), { force: true });
    }
  });

  it("returns the provider error when no account is left, then fails fast with a non-retryable error", async () => {
    const { router, binding } = services([]);
    const { delegate, calls } = scriptedDelegate({ "key-default": "usage-limit" });
    const stream = createAccountStreamSimple({ router, binding, delegate });
    const first = stream(model, context, { apiKey: "key-default" });
    await collect(first);
    expect((await first.result()).errorMessage).toBe(weeklyLimit);
    const second = stream(model, context, { apiKey: "key-default" });
    const events = await collect(second);
    const result = await second.result();
    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(result.errorMessage).toMatch(/quota exceeded .*default: weekly usage limit reached until/);
    expect(isRetryableAssistantError(result)).toBe(false);
    await router.settle();
  });

  it("reports cancellation during account selection as an aborted result", async () => {
    const { router, binding } = services(twoAccounts);
    const { delegate, calls } = scriptedDelegate({});
    const controller = new AbortController();
    controller.abort();
    const response = createAccountStreamSimple({ router, binding, delegate })(model, context, {
      apiKey: "key-default",
      signal: controller.signal,
    });
    const events = await collect(response);
    expect(events).toEqual([expect.objectContaining({ type: "error", reason: "aborted" })]);
    expect((await response.result()).stopReason).toBe("aborted");
    expect(calls).toHaveLength(0);
  });
});

describe("account stream with Pi's openai-completions implementation", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("puts each account's key on the actual HTTP request", async () => {
    const authorizations: (string | null)[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/api/balance")) return Response.json(healthy);
      const authorization = new Headers(init?.headers).get("Authorization");
      authorizations.push(authorization);
      if (authorization === "Bearer key-default") {
        return Response.json(
          { error: "you (fixture) have reached your session usage limit, upgrade for higher limits" },
          { status: 429 },
        );
      }
      return chatResponse();
    }) as typeof fetch;
    const { router, binding } = services([{ id: "work", apiKey: "key-work" }]);
    const response = createAccountStreamSimple({ router, binding })(model, context, {
      apiKey: "key-default",
      maxRetries: 0,
    });
    const result = await response.result();
    expect(result.stopReason).toBe("stop");
    expect(authorizations).toEqual(["Bearer key-default", "Bearer key-work"]);
    expect(binding.accountId).toBe("work");
    await router.settle();
  });
});
