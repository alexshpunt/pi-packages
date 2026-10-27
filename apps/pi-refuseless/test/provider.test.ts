import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AuthInteraction,
  type AuthPrompt,
  type Context,
  createModels,
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  type Provider,
  type RefreshModelsContext,
  type ThinkingLevel,
  Type,
} from "@earendil-works/pi-ai";
import { type ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from "vitest";
import {
  apiError,
  chunk,
  MOCK_CATALOG,
  type MockOptions,
  type MockRefuseless,
  startMockRefuseless,
  streamFrames,
  usageChunk,
} from "../scripts/mock-refuseless.ts";
import refuseless from "../src/index.ts";
import { catalogModels, fetchRefuselessModels, type RefuselessModel } from "../src/models.ts";
import { levelAfterSwitch } from "../src/thinking.ts";

const KEY = "abl_unit-test-key";
const CATALOG_IDS = MOCK_CATALOG.map((entry) => entry.id);
/** Entries the real catalog does not have, one per case of the conversion. */
const EDGE_CATALOG = [
  { id: "high-max", context_length: 1_048_576, reasoning_efforts: ["high", "max"], reasoning_default: "high" },
  { id: "only-off", context_length: 1_048_576, reasoning_efforts: ["off"], reasoning_default: "off" },
  { id: "unlisted", context_length: 1_048_576 },
];

/** Runs the extension factory against a Pi API stub that records every call and event handler. */
function loadExtension() {
  const calls: string[] = [];
  const providers: Provider[] = [];
  const handlers = new Map<string, (event: any) => unknown>();
  let thinkingLevel = "off";
  const pi = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        (...args: any[]) => {
          if (name === "getThinkingLevel") return thinkingLevel;
          calls.push(name === "on" ? `on ${args[0]}` : String(name));
          if (name === "registerProvider") providers.push(args[0] as Provider);
          if (name === "on") handlers.set(args[0], args[1]);
          if (name === "setThinkingLevel") thinkingLevel = args[0];
        },
    },
  ) as ExtensionAPI;
  refuseless(pi);
  return {
    calls,
    providers,
    handlers,
    thinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level: string) => {
      thinkingLevel = level;
    },
  };
}

const provider = () => loadExtension().providers[0]!;

function interaction(answer: (prompt: AuthPrompt) => Promise<string>): AuthInteraction & { signal: AbortSignal } {
  return { signal: new AbortController().signal, prompt: answer, notify: () => {} };
}

/** Pi's refresh context for `fetchRefuselessModels`, aimed at `baseUrl`. */
function refreshContext(baseUrl: string, overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    credential: { type: "api_key", key: KEY },
    allowNetwork: true,
    signal: new AbortController().signal,
    baseUrl,
    publish: async () => true,
    ...overrides,
  };
}

// Every request in this file must stay on the local mock.
const realFetch = globalThis.fetch;
let fetchGuard: MockInstance<typeof fetch>;
let mock: MockRefuseless | undefined;
const savedKey = process.env.REFUSELESS_API_KEY;
beforeEach(() => {
  delete process.env.REFUSELESS_API_KEY;
  fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("http://127.0.0.1:")) throw new Error(`Blocked request to ${url}`);
    return realFetch(input, init);
  });
});
afterEach(async () => {
  await mock?.close();
  mock = undefined;
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.REFUSELESS_API_KEY;
  else process.env.REFUSELESS_API_KEY = savedKey;
});

/** A Models service holding Refuseless and a saved key, plus the mock's catalog converted to Pi models. */
async function withMock(options: MockOptions = {}) {
  mock = await startMockRefuseless(options);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("refuseless", async () => ({ type: "api_key", key: KEY }));
  const models = createModels({ credentials });
  models.setProvider(provider());
  const catalog = await fetchRefuselessModels(refreshContext(mock.baseUrl));
  mock.requests.length = 0;
  const model = (id = "glm-5.3-flash-abliterated") => ({
    ...catalog.find((entry) => entry.id === id)!,
    baseUrl: mock!.baseUrl,
  });
  return { models, model, mock };
}

async function run(
  models: ReturnType<typeof createModels>,
  model: Model<any>,
  context: Context,
  options: Parameters<ReturnType<typeof createModels>["streamSimple"]>[2] = {},
) {
  const events: AssistantMessageEvent[] = [];
  const stream = models.streamSimple(model, context, options);
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

const ask = (text: string): Context => ({ messages: [{ role: "user", content: text, timestamp: 1 }] });

describe("registration", () => {
  test("registers one Refuseless provider with no fixed models and a model_select handler, without a network call", () => {
    const { calls, providers } = loadExtension();
    expect(calls).toStrictEqual(["registerProvider", "on model_select"]);
    expect(providers).toHaveLength(1);
    const [registered] = providers;
    expect(registered!.id).toBe("refuseless");
    expect(registered!.name).toBe("Refuseless");
    expect(registered!.baseUrl).toBe("https://api.refuseless.com/v1");
    expect(registered!.auth.apiKey?.name).toBe("Refuseless API key");
    expect(typeof registered!.auth.apiKey?.login).toBe("function");
    expect(registered!.auth.oauth).toBe(undefined);
    expect(registered!.getModels()).toStrictEqual([]);
    expect(typeof registered!.refreshModels).toBe("function");
    expect(fetchGuard).not.toHaveBeenCalled();
  });
});

describe("API key login", () => {
  test("asks for the key with Pi's secret prompt and returns the trimmed key", async () => {
    const prompts: AuthPrompt[] = [];
    const credential = await provider().auth.apiKey!.login!(
      interaction(async (prompt) => {
        prompts.push(prompt);
        return `  ${KEY}\t`;
      }),
    );
    expect(prompts.map(({ type, message }) => ({ type, message }))).toStrictEqual([
      { type: "secret", message: "Enter Refuseless API key" },
    ]);
    expect(credential).toStrictEqual({ type: "api_key", key: KEY });
  });

  test("blank entry and cancellation keep the saved key and unrelated credentials", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("refuseless", async () => ({ type: "api_key", key: "abl_saved" }));
    await credentials.modify("other", async () => ({ type: "api_key", key: "other-key" }));
    const models = createModels({ credentials });
    models.setProvider(provider());

    await expect(
      models.login(
        "refuseless",
        "api_key",
        interaction(async () => "   "),
      ),
    ).rejects.toThrow("API key is empty");
    await expect(
      models.login(
        "refuseless",
        "api_key",
        interaction(async () => {
          throw new Error("Login cancelled");
        }),
      ),
    ).rejects.toThrow("Login cancelled");
    expect(await credentials.read("refuseless")).toStrictEqual({ type: "api_key", key: "abl_saved" });

    await models.login(
      "refuseless",
      "api_key",
      interaction(async () => "abl_replaced"),
    );
    expect(await credentials.read("refuseless")).toStrictEqual({ type: "api_key", key: "abl_replaced" });
    await models.logout("refuseless");
    expect(await credentials.read("refuseless")).toBe(undefined);
    expect(await credentials.read("other")).toStrictEqual({ type: "api_key", key: "other-key" });
  });

  test("a stored key wins over REFUSELESS_API_KEY", async () => {
    const env = new Map<string, string>();
    const credentials = new InMemoryCredentialStore();
    const models = createModels({
      credentials,
      authContext: { env: async (name) => env.get(name), fileExists: async () => false },
    });
    models.setProvider(provider());
    expect(await models.getAuth("refuseless")).toBe(undefined);
    env.set("REFUSELESS_API_KEY", "abl_from_env");
    expect((await models.getAuth("refuseless"))?.auth.apiKey).toBe("abl_from_env");
    await credentials.modify("refuseless", async () => ({ type: "api_key", key: KEY }));
    expect((await models.getAuth("refuseless"))?.auth.apiKey).toBe(KEY);
  });
});

describe("model list from GET /v1/models", () => {
  test("lists every catalog model, fetched with the saved key", async () => {
    mock = await startMockRefuseless();
    const models = await fetchRefuselessModels(refreshContext(mock.baseUrl));
    expect(mock.requests.map(({ method, path, authorization }) => [method, path, authorization])).toStrictEqual([
      ["GET", "/v1/models", `Bearer ${KEY}`],
    ]);
    expect(models.map((model) => model.id)).toStrictEqual(CATALOG_IDS);
  });

  test("takes context, thinking levels and their default from the real catalog and fills the fields it lacks", async () => {
    mock = await startMockRefuseless();
    const models = await fetchRefuselessModels(refreshContext(mock.baseUrl));
    const summary = models.map((model) => [
      model.id,
      model.contextWindow,
      model.maxTokens,
      getSupportedThinkingLevels(model).join(","),
      model.reasoningDefault,
    ]);
    expect(summary).toStrictEqual([
      ["glm-5.3-abliterated", 1_048_576, 131_072, "low,high,max", "low"],
      ["glm-5.3-flash-abliterated", 1_048_576, 131_072, "low,high,max", "low"],
      ["deepseek-v4.1-flash-abliterated", 1_048_576, 131_072, "off,low,high,max", "low"],
      ["deepseek-v4.1-flash-fast", 1_048_576, 131_072, "off,low,high,max", "low"],
      ["minimax-m3.1-flash", 1_048_576, 131_072, "low,high,max", "low"],
      ["deepseek-v4.1-flash-free", 524_288, 131_072, "low,high,max", "low"],
    ]);
    for (const model of models) {
      expect(model).toMatchObject({
        name: model.id,
        provider: "refuseless",
        api: "openai-completions",
        baseUrl: "https://api.refuseless.com/v1",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false },
        reasoning: true,
      });
    }
  });

  test("handles missing fields, the none alias, an unoffered default and entries without an ID", async () => {
    mock = await startMockRefuseless({
      catalog: [
        ...EDGE_CATALOG,
        {
          id: "small",
          context_length: 32_768,
          reasoning_efforts: ["none", "high"],
          reasoning_default: "none",
        } as never,
        { id: "stray-default", reasoning_efforts: ["high", "max"], reasoning_default: "low" } as never,
        {
          id: "other-names",
          reasoning_efforts: ["minimal", "medium", "xhigh", "ultra"],
          reasoning_default: "medium",
        } as never,
        { id: "" },
        { object: "model" } as never,
      ],
    });
    const models = await fetchRefuselessModels(refreshContext(mock.baseUrl));
    expect(
      models.map((model) => [
        model.id,
        model.contextWindow,
        model.maxTokens,
        model.reasoning,
        getSupportedThinkingLevels(model).join(","),
        model.reasoningDefault,
      ]),
    ).toStrictEqual([
      ["high-max", 1_048_576, 131_072, true, "high,max", "high"],
      // Only "off": no thinking levels in Pi, so no default either.
      ["only-off", 1_048_576, 131_072, false, "off", undefined],
      // No reasoning_efforts: no thinking levels.
      ["unlisted", 1_048_576, 131_072, false, "off", undefined],
      ["small", 32_768, 32_768, true, "off,high", "off"],
      ["stray-default", 128_000, 128_000, true, "high,max", undefined],
      // Every value named like a Pi level is used; "ultra" is not a Pi level.
      ["other-names", 128_000, 128_000, true, "minimal,medium,xhigh", "medium"],
    ]);
    // Each level sends the value the model lists.
    expect(models.find((model) => model.id === "small")!.thinkingLevelMap).toMatchObject({ off: "none", high: "high" });
  });

  test("Pi fetches with REFUSELESS_API_KEY when no key is saved", async () => {
    mock = await startMockRefuseless();
    const models = createModels({
      credentials: new InMemoryCredentialStore(),
      authContext: {
        env: async (name) => (name === "REFUSELESS_API_KEY" ? "abl_from_env" : undefined),
        fileExists: async () => false,
      },
    });
    const registered = provider();
    models.setProvider({
      ...registered,
      refreshModels: (context) => registered.refreshModels!({ ...context, baseUrl: mock!.baseUrl }),
    });
    await models.refresh({ providers: ["refuseless"], allowNetwork: true });
    expect(mock.requests.map((request) => request.authorization)).toStrictEqual(["Bearer abl_from_env"]);
    expect(models.getModels("refuseless").map((model) => model.id)).toStrictEqual(CATALOG_IDS);
  });

  test("without a key it keeps the saved list and sends nothing", async () => {
    mock = await startMockRefuseless();
    const saved = (await fetchRefuselessModels(refreshContext(mock.baseUrl))).slice(0, 2);
    mock.requests.length = 0;
    const models = await fetchRefuselessModels(
      refreshContext(mock.baseUrl, { credential: undefined, stored: { models: saved } as never }),
    );
    expect(models).toStrictEqual(saved);
    expect(mock.requests).toStrictEqual([]);
  });

  test.each([
    [
      "a rejected key",
      { status: 401, body: { error: { code: "invalid_key", message: "Invalid API key." } } },
      /HTTP 401 \(invalid_key: Invalid API key\.\)/,
    ],
    ["an unreachable billing service", { status: 503, body: {} }, /HTTP 503$/],
    ["a response without a list", { status: 200, body: { object: "list" } }, /returned no model list/],
  ])("fails on %s", async (_name, reply, error) => {
    mock = await startMockRefuseless({
      respond: (_request, response) => {
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.body));
        return true;
      },
    });
    await expect(fetchRefuselessModels(refreshContext(mock.baseUrl))).rejects.toThrow(error);
  });

  test("Pi fetches the list through models.json's endpoint, restores it offline and drops removed models", async () => {
    const catalog = [...MOCK_CATALOG];
    mock = await startMockRefuseless({ catalog });
    const directory = await mkdtemp(join(tmpdir(), "pi-refuseless-refresh-"));
    const paths = {
      authPath: join(directory, "auth.json"),
      modelsPath: join(directory, "models.json"),
      modelsStorePath: join(directory, "models-store.json"),
    };
    await writeFile(paths.modelsPath, JSON.stringify({ providers: { refuseless: { baseUrl: mock.baseUrl } } }));
    await writeFile(paths.authPath, JSON.stringify({ refuseless: { type: "api_key", key: KEY } }));
    const open = async () => {
      const runtime = await ModelRuntime.create({ ...paths, refreshOnCreate: false, allowModelNetwork: false });
      runtime.registerNativeProvider(provider());
      return runtime;
    };
    const ids = (runtime: ModelRuntime) => runtime.getModels("refuseless").map((model) => model.id);
    try {
      const first = await open();
      expect(ids(first)).toStrictEqual([]);
      // Registration starts a background refresh that can supersede one started right after it; Pi's own
      // network refreshes come later (after login, on /model).
      await vi.waitFor(async () => {
        const result = await first.refresh({ providers: ["refuseless"], allowNetwork: true });
        expect([...result.errors.values()]).toStrictEqual([]);
        expect(ids(first)).toStrictEqual(CATALOG_IDS);
      });
      expect(first.getModels("refuseless").every((model) => model.baseUrl === mock!.baseUrl)).toBe(true);
      expect((await first.getAvailable("refuseless")).map((model) => model.id)).toStrictEqual(CATALOG_IDS);

      // Registering the provider restores the saved list in the background, without the network.
      const fetches = mock.requests.length;
      const restarted = await open();
      await vi.waitFor(() => expect(ids(restarted)).toStrictEqual(CATALOG_IDS));
      expect(mock.requests).toHaveLength(fetches);
      const restored = restarted.getModels("refuseless") as RefuselessModel[];
      expect(restored.map((model) => model.reasoningDefault)).toStrictEqual(CATALOG_IDS.map(() => "low"));
      expect(getSupportedThinkingLevels(restored[0]!)).toStrictEqual(["low", "high", "max"]);

      catalog.splice(4, 1);
      await restarted.refresh({ providers: ["refuseless"], allowNetwork: true });
      expect(ids(restarted)).toStrictEqual(CATALOG_IDS.filter((id) => id !== "minimax-m3.1-flash"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("Pi keeps the previous list when a refresh fails", async () => {
    mock = await startMockRefuseless();
    const models = createModels({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore() });
    const registered = provider();
    let fail = false;
    models.setProvider({
      ...registered,
      refreshModels: (context) =>
        registered.refreshModels!({ ...context, baseUrl: fail ? "http://127.0.0.1:1/v1" : mock!.baseUrl }),
    });
    await models.login(
      "refuseless",
      "api_key",
      interaction(async () => KEY),
    );
    await models.refresh({ providers: ["refuseless"], allowNetwork: true });
    expect(models.getModels("refuseless")).toHaveLength(CATALOG_IDS.length);
    fail = true;
    const result = await models.refresh({ providers: ["refuseless"], allowNetwork: true });
    expect(result.errors.get("refuseless")).toBeInstanceOf(Error);
    expect(models.getModels("refuseless")).toHaveLength(CATALOG_IDS.length);
  });
});

describe("thinking level after picking a model", () => {
  const refuselessModel = (efforts: string[], reasoningDefault: string | undefined) => {
    const [model] = catalogModels([{ id: "m", reasoning_efforts: efforts, reasoning_default: reasoningDefault }]);
    return model!;
  };
  const withOff = refuselessModel(["off", "low", "high", "max"], "low");
  const withoutOff = refuselessModel(["low", "high", "max"], "high");
  const otherThinking = { provider: "other", id: "x", reasoning: true } as Model<any>;
  const otherPlain = { provider: "other", id: "y", reasoning: false } as Model<any>;

  test.each([
    ["no model before, carried off", withOff, undefined, "off", "low"],
    ["a model without thinking before, carried off", withOff, otherPlain, "off", "low"],
    ["no model before, off moved up to low by Pi", withoutOff, undefined, "low", "high"],
    ["a model with thinking before: its level stays", withOff, otherThinking, "off", undefined],
    ["a model with thinking before: Pi's move up stays", withoutOff, otherThinking, "low", undefined],
    ["a thinking setting chose another level", withOff, undefined, "max", undefined],
    ["already at the default", withOff, undefined, "low", undefined],
  ] as const)("%s", (_name, model, previous, level, expected) => {
    expect(levelAfterSwitch(model, previous, level)).toBe(expected);
  });

  test("leaves other providers and Refuseless models without a default alone", () => {
    expect(levelAfterSwitch({ ...otherThinking, reasoningDefault: "low" } as Model<any>, undefined, "off")).toBe(
      undefined,
    );
    expect(levelAfterSwitch(refuselessModel(["off", "low"], undefined), undefined, "off")).toBe(undefined);
  });

  test("the model_select handler sets the default, except for a restored session", () => {
    const extension = loadExtension();
    const select = extension.handlers.get("model_select")!;
    select({ type: "model_select", model: withOff, previousModel: undefined, source: "restore" });
    expect(extension.thinkingLevel()).toBe("off");
    for (const source of ["set", "cycle"]) {
      extension.setThinkingLevel("off");
      select({ type: "model_select", model: withOff, previousModel: undefined, source });
      expect(extension.thinkingLevel(), source).toBe("low");
    }
  });
});

describe("requests", () => {
  test("streams reasoning and text with the saved key and the catalog model ID", async () => {
    const { models, model, mock } = await withMock();
    const { events, message } = await run(models, model(), ask("Say ok."), { reasoning: "high" });

    expect(mock.requests).toHaveLength(1);
    const [request] = mock.requests;
    expect(request!.method).toBe("POST");
    expect(request!.path).toBe("/v1/chat/completions");
    expect(request!.authorization).toBe(`Bearer ${KEY}`);
    expect(request!.body).toMatchObject({
      model: "glm-5.3-flash-abliterated",
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "high",
      max_completion_tokens: 131_072,
    });
    expect(message.stopReason).toBe("stop");
    expect(message.content).toMatchObject([
      { type: "thinking", thinking: "Mock reasoning." },
      { type: "text", text: "Mock Refuseless reply from glm-5.3-flash-abliterated (reasoning_effort: high)." },
    ]);
    expect(message.usage).toMatchObject({ input: 12, output: 8 });
    expect(events.at(-1)?.type).toBe("done");
  });

  test("sends only reasoning_effort values the model offers", async () => {
    const { models, model, mock } = await withMock({ catalog: [...MOCK_CATALOG, ...EDGE_CATALOG] });
    const levels: (ThinkingLevel | undefined)[] = [undefined, "minimal", "low", "medium", "high", "xhigh", "max"];
    const full = ["off", "low", "low", "high", "high", "max", "max"];
    const expected: Record<string, (string | undefined)[]> = {
      // No "off": a request without a level sends nothing, so the model's reasoning_default applies.
      "glm-5.3-abliterated": [undefined, "low", "low", "high", "high", "max", "max"],
      "deepseek-v4.1-flash-abliterated": full,
      "high-max": [undefined, "high", "high", "high", "high", "max", "max"],
      "only-off": levels.map(() => undefined),
      unlisted: levels.map(() => undefined),
    };
    for (const [id, efforts] of Object.entries(expected)) {
      for (const [index, level] of levels.entries()) {
        const { message } = await run(models, model(id), ask("hello"), { reasoning: level });
        expect(message.stopReason, `${id} ${level}: ${message.errorMessage}`).toBe("stop");
        expect(mock.requests.at(-1)!.body.reasoning_effort, `${id} ${level}`).toBe(efforts[index]);
      }
    }
  });

  test.each(["glm-5.3-abliterated", "deepseek-v4.1-flash-abliterated", "minimax-m3.1-flash"])(
    "round-trips a tool call and its result with %s",
    async (id) => {
      const { models, model: mockModel, mock } = await withMock();
      const model = () => mockModel(id);
      const tool = { name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) };
      const context: Context = { ...ask("use a tool"), tools: [tool] };

      const first = await run(models, model(), context);
      expect(first.message.stopReason).toBe("toolUse");
      const call = first.message.content.find((block) => block.type === "toolCall");
      expect(call).toMatchObject({
        type: "toolCall",
        id: "call_mock_1",
        name: "bash",
        arguments: { command: "echo refuseless-mock-tool" },
      });
      expect(mock.requests[0]!.body.tools).toMatchObject([{ type: "function", function: { name: "bash" } }]);

      context.messages.push(first.message, {
        role: "toolResult",
        toolCallId: "call_mock_1",
        toolName: "bash",
        content: [{ type: "text", text: "refuseless-mock-tool" }],
        isError: false,
        timestamp: 2,
      });
      const second = await run(models, model(), context);
      expect(second.message.stopReason).toBe("stop");
      expect(second.message.content).toMatchObject([{ type: "text", text: "Tool result: refuseless-mock-tool" }]);
      const sent = mock.requests[1]!.body.messages;
      expect(sent.at(-2)).toMatchObject({
        role: "assistant",
        tool_calls: [{ id: "call_mock_1", function: { name: "bash" } }],
      });
      expect(sent.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_mock_1" });
    },
  );

  test("sends the system prompt with the system role for every model", async () => {
    const { models, model, mock } = await withMock();
    for (const id of CATALOG_IDS) {
      await run(models, model(id), { systemPrompt: "Be brief.", ...ask("hello") }, { reasoning: "low" });
      expect(mock.requests.at(-1)!.body.messages[0], id).toMatchObject({ role: "system" });
    }
  });

  test("reports usage with cached prompt tokens", async () => {
    const { models, model } = await withMock({
      respond: async (request, response) => {
        if (request.method !== "POST") return false;
        await streamFrames(response, [
          chunk(request.body.model, { content: "ok" }),
          chunk(request.body.model, {}, "stop"),
          usageChunk(request.body.model, 100, 20, 40),
        ]);
        return true;
      },
    });
    const { message } = await run(models, model(), ask("hello"));
    expect(message.usage).toMatchObject({ input: 60, cacheRead: 40, output: 20, totalTokens: 120 });
  });

  test("cancels mid-stream and closes the connection", async () => {
    const { models, model, mock } = await withMock({
      respond: async (request, response) => {
        if (request.method !== "POST") return false;
        const frames = Array.from({ length: 50 }, (_, index) => chunk(request.body.model, { content: `${index} ` }));
        await streamFrames(response, [...frames, chunk(request.body.model, {}, "stop")], { delayMs: 50 });
        return true;
      },
    });
    const controller = new AbortController();
    const events: AssistantMessageEvent[] = [];
    const stream = models.streamSimple(model(), ask("count"), { signal: controller.signal });
    for await (const event of stream) {
      events.push(event);
      if (event.type === "text_delta") controller.abort();
    }
    const message = await stream.result();
    expect(message.stopReason).toBe("aborted");
    expect(events.some((event) => event.type === "done")).toBe(false);
    await vi.waitFor(() => expect(mock.disconnects).toHaveLength(1));
  });

  test.each([
    [401, "invalid_key", "Invalid API key."],
    [402, "insufficient_credits", "Out of credits."],
    [404, "model_not_found", "Unknown model."],
    [429, "model_busy", "Model is busy. Retry shortly."],
    [503, "gateway_down", "Gateway unreachable."],
  ])("ends with an error for HTTP %i %s", async (status, code, text) => {
    const { models, model } = await withMock({
      respond: (request, response) => {
        if (request.method !== "POST") return false;
        apiError(response, status, code, text, status === 429 ? { "retry-after": "15" } : {});
        return true;
      },
    });
    const { events, message } = await run(models, model(), ask("hello"));
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain(text);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  test("ends with an error when credits run out mid-stream", async () => {
    const { models, model } = await withMock();
    const { events, message } = await run(models, model(), ask("use all my credits"));
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("Credits ran out. Generation stopped.");
    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  test.each([
    ["an invalid JSON frame", ["{not json"]],
    ["a stream without finish_reason", [chunk("glm-5.3-flash-abliterated", { content: "cut" })]],
  ])("ends with an error on %s", async (_name, frames) => {
    const { models, model } = await withMock({
      respond: async (request, response) => {
        if (request.method !== "POST") return false;
        await streamFrames(response, frames);
        return true;
      },
    });
    const { events, message } = await run(models, model(), ask("hello"));
    expect(message.stopReason).toBe("error");
    expect((message as AssistantMessage).errorMessage).toBeTruthy();
    expect(events.at(-1)?.type).toBe("error");
  });
});
