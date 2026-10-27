import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore, type Model, type Provider } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { apiError, MOCK_CREDITS, type MockRefuseless, startMockRefuseless } from "../scripts/mock-refuseless.ts";
import { registerRefuselessCommand } from "../src/command.ts";
import { formatUsd, readCredits, requestCredits } from "../src/credits.ts";
import { CREDITS_STATUS_KEY, type CreditsStatus, registerCreditsStatus } from "../src/credits-status.ts";
import refuseless from "../src/index.ts";

const KEY = "abl_credits-test-key";
const REFUSELESS_MODEL = { provider: "refuseless", id: "glm-5.3-abliterated" } as Model<any>;
const OTHER_MODEL = { provider: "other", id: "x" } as Model<any>;

// Every request in this file must stay on the local mock; each test gets its own agent directory.
const realFetch = globalThis.fetch;
let mock: MockRefuseless | undefined;
let agentDir: string;
const savedEnv = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  REFUSELESS_API_KEY: process.env.REFUSELESS_API_KEY,
};
beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-refuseless-credits-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.REFUSELESS_API_KEY;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("http://127.0.0.1:")) throw new Error(`Blocked request to ${url}`);
    return realFetch(input, init);
  });
});
afterEach(async () => {
  await mock?.close();
  mock = undefined;
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(agentDir, { recursive: true, force: true });
});

const settingsFile = () => join(agentDir, "refuseless.json");
const creditReads = () => mock!.requests.filter((request) => request.path === "/v1/credits");
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** A mock whose `GET /v1/credits` answers with MOCK_CREDITS changed by `credits()`. */
async function creditsMock(credits: () => object = () => ({})) {
  mock = await startMockRefuseless({
    respond: (request, response) => {
      if (request.path !== "/v1/credits") return false;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...MOCK_CREDITS, ...credits() }));
      return true;
    },
  });
}

/** Pi's model registry as the extension sees it: `key` (null for none) for Refuseless and its provider at `baseUrl`. */
function registry(baseUrl: string | undefined, key: string | null = KEY) {
  return {
    getApiKeyForProvider: async () => key ?? undefined,
    getProvider: () => (baseUrl ? { baseUrl } : undefined),
  } as unknown as ExtensionContext["modelRegistry"];
}

describe("GET /v1/credits", () => {
  test("reads the balance with the key", async () => {
    mock = await startMockRefuseless();
    expect(await requestCredits(mock.baseUrl, KEY)).toStrictEqual({
      balance: 42.5,
      reserved: 1.2,
      available: 41.3,
      keyLimit: null,
    });
    expect(mock.requests.map(({ method, path, authorization }) => [method, path, authorization])).toStrictEqual([
      ["GET", "/v1/credits", `Bearer ${KEY}`],
    ]);
  });

  test("keeps a key budget and takes a missing one as none", async () => {
    let keyLimit: number | undefined = 5.25;
    await creditsMock(() => ({ key_limit: keyLimit }));
    expect((await requestCredits(mock!.baseUrl, KEY)).keyLimit).toBe(5.25);
    keyLimit = undefined;
    expect((await requestCredits(mock!.baseUrl, KEY)).keyLimit).toBe(null);
  });

  test.each([
    [401, "invalid_key", "Invalid API key.", /HTTP 401 \(invalid_key: Invalid API key\.\)/],
    [
      429,
      "rate_limit_exceeded",
      "Too many balance reads.",
      /HTTP 429 \(rate_limit_exceeded: Too many balance reads\.\)/,
    ],
    [503, "gateway_down", "Billing service unreachable.", /HTTP 503 \(gateway_down: Billing service unreachable\.\)/],
  ])("fails on HTTP %i %s", async (status, code, message, error) => {
    mock = await startMockRefuseless({
      respond: (_request, response) => {
        apiError(response, status, code, message);
        return true;
      },
    });
    await expect(requestCredits(mock.baseUrl, KEY)).rejects.toThrow(error);
  });

  test("fails on a response without a balance", async () => {
    await creditsMock(() => ({ available: "41.3" }));
    await expect(requestCredits(mock!.baseUrl, KEY)).rejects.toThrow(/\/v1\/credits returned no credit balance$/);
  });

  test("uses the key Pi resolves and the endpoint models.json sets, and sends nothing without a key", async () => {
    mock = await startMockRefuseless();
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({ providers: { refuseless: { baseUrl: mock.baseUrl } } }),
    );
    let provider: Provider | undefined;
    refuseless({
      registerProvider: (value: Provider) => {
        provider = value;
      },
      on: () => {},
      registerCommand: () => {},
    } as unknown as ExtensionAPI);
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(provider!);
    const modelRegistry = new ModelRegistry(runtime);

    expect(await readCredits({ modelRegistry })).toBe(undefined);
    expect(creditReads()).toStrictEqual([]);

    process.env.REFUSELESS_API_KEY = "abl_from_env";
    expect(await readCredits({ modelRegistry })).toMatchObject({ available: 41.3 });
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({ refuseless: { type: "api_key", key: KEY } }));
    await runtime.refresh({ allowNetwork: false });
    expect(await readCredits({ modelRegistry })).toMatchObject({ available: 41.3 });
    expect(creditReads().map((request) => request.authorization)).toStrictEqual([
      "Bearer abl_from_env",
      `Bearer ${KEY}`,
    ]);
  });

  test("goes to api.refuseless.com when Pi reports no endpoint", async () => {
    await expect(readCredits({ modelRegistry: registry(undefined) })).rejects.toThrow(
      "Blocked request to https://api.refuseless.com/v1/credits",
    );
  });

  test.each([
    [41.3, "$41.30"],
    [0, "$0.00"],
    [0.000125, "$0.000125"],
    [1234.5, "$1,234.50"],
  ])("formats %d as %s", (amount, text) => {
    expect(formatUsd(amount)).toBe(text);
  });
});

/** `registerCreditsStatus` on a Pi API stub, with a way to send it Pi's events. */
function statusExtension() {
  const handlers = new Map<string, (event: object, ctx: ExtensionContext) => unknown>();
  const status = registerCreditsStatus({
    on: (name: string, handler: (event: object, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
  } as unknown as ExtensionAPI);
  const emit = (type: string, ctx: ExtensionContext, event: object = {}) =>
    handlers.get(type)!({ type, ...event }, ctx);
  return { status, emit };
}

/** An interactive Pi session on a Refuseless model, recording what the extension puts in the status line. */
function session(modelRegistry: ExtensionContext["modelRegistry"], mode: ExtensionContext["mode"] = "tui") {
  const statuses: (string | undefined)[] = [];
  const ctx = {
    mode,
    model: REFUSELESS_MODEL as Model<any> | undefined,
    modelRegistry,
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        expect(key).toBe(CREDITS_STATUS_KEY);
        statuses.push(text);
      },
    },
  };
  return { ctx: ctx as typeof ctx & ExtensionContext, statuses, shown: () => statuses.at(-1) };
}

describe("credits in the status line", () => {
  test("shows the available credits on a Refuseless model, reads them after each reply and clears them for another model", async () => {
    let available = 41.3;
    await creditsMock(() => ({ available }));
    const { emit } = statusExtension();
    const { ctx, shown } = session(registry(mock!.baseUrl));

    emit("session_start", ctx);
    await vi.waitFor(() => expect(shown()).toBe("Refuseless $41.30"));
    expect(creditReads().map((request) => request.authorization)).toStrictEqual([`Bearer ${KEY}`]);

    available = 40.05;
    emit("agent_end", ctx);
    await vi.waitFor(() => expect(shown()).toBe("Refuseless $40.05"));

    ctx.model = OTHER_MODEL;
    emit("model_select", ctx, { model: OTHER_MODEL });
    expect(shown()).toBe(undefined);
    emit("agent_end", ctx);
    await settle();
    expect(shown()).toBe(undefined);
    expect(creditReads()).toHaveLength(2);

    emit("model_select", ctx, { model: REFUSELESS_MODEL });
    await vi.waitFor(() => expect(shown()).toBe("Refuseless $40.05"));
    emit("session_shutdown", ctx);
    expect(shown()).toBe(undefined);
    expect(creditReads()).toHaveLength(3);
  });

  test("reads nothing outside interactive Pi or without a key, and clears the entry when a read fails", async () => {
    let fail = false;
    mock = await startMockRefuseless({
      respond: (request, response) => {
        if (request.path !== "/v1/credits") return false;
        if (fail) apiError(response, 401, "invalid_key", "Invalid API key.");
        else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(MOCK_CREDITS));
        }
        return true;
      },
    });
    const printMode = session(registry(mock!.baseUrl), "print");
    statusExtension().emit("session_start", printMode.ctx);
    const noKey = session(registry(mock!.baseUrl, null));
    statusExtension().emit("session_start", noKey.ctx);
    await settle();
    expect(printMode.statuses).toStrictEqual([]);
    expect(noKey.statuses).toStrictEqual([undefined]);
    expect(creditReads()).toStrictEqual([]);

    const { emit } = statusExtension();
    const { ctx, statuses } = session(registry(mock!.baseUrl));
    emit("session_start", ctx);
    await vi.waitFor(() => expect(statuses).toStrictEqual(["Refuseless $41.30"]));
    fail = true;
    emit("agent_end", ctx);
    await vi.waitFor(() => expect(statuses).toStrictEqual(["Refuseless $41.30", undefined]));
  });

  test("drops a read that a model switch overtook", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock = await startMockRefuseless({
      respond: async (request, response) => {
        if (request.path !== "/v1/credits") return false;
        await held;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(MOCK_CREDITS));
        return true;
      },
    });
    const { emit } = statusExtension();
    const { ctx, statuses } = session(registry(mock!.baseUrl));
    emit("session_start", ctx);
    await vi.waitFor(() => expect(creditReads()).toHaveLength(1));
    ctx.model = OTHER_MODEL;
    emit("model_select", ctx, { model: OTHER_MODEL });
    // The read is cancelled: the connection closes while the mock still holds the reply.
    await vi.waitFor(() => expect(mock!.disconnects).toHaveLength(1));
    release();
    await settle();
    expect(statuses).toStrictEqual([undefined]);
  });

  test("turning it off clears the entry and saves the choice, which the next start keeps, along with other settings", async () => {
    await creditsMock();
    await writeFile(settingsFile(), JSON.stringify({ other: 1 }));
    const first = statusExtension();
    const { ctx, shown } = session(registry(mock!.baseUrl));
    expect(first.status.isEnabled()).toBe(true);
    first.emit("session_start", ctx);
    await vi.waitFor(() => expect(shown()).toBe("Refuseless $41.30"));

    expect(first.status.setEnabled(false, ctx)).toBe(undefined);
    expect(shown()).toBe(undefined);
    expect(JSON.parse(await readFile(settingsFile(), "utf8"))).toStrictEqual({ other: 1, creditsStatus: false });
    first.emit("agent_end", ctx);
    await settle();
    expect(shown()).toBe(undefined);
    expect(creditReads()).toHaveLength(1);

    const next = statusExtension();
    expect(next.status.isEnabled()).toBe(false);
    next.emit("session_start", ctx);
    await settle();
    expect(creditReads()).toHaveLength(1);

    expect(next.status.setEnabled(true, ctx)).toBe(undefined);
    await vi.waitFor(() => expect(shown()).toBe("Refuseless $41.30"));
    expect(JSON.parse(await readFile(settingsFile(), "utf8"))).toStrictEqual({ other: 1, creditsStatus: true });
  });

  test("leaves a settings file that is not a JSON object alone and applies the choice until Pi restarts", async () => {
    await creditsMock();
    await writeFile(settingsFile(), "{not json");
    const first = statusExtension();
    const { ctx, shown } = session(registry(mock!.baseUrl));
    expect(first.status.isEnabled()).toBe(true);
    expect(first.status.setEnabled(false, ctx)).toBe(`${settingsFile()} is not valid JSON; fix or remove it.`);
    expect(first.status.isEnabled()).toBe(false);
    expect(shown()).toBe(undefined);
    expect(await readFile(settingsFile(), "utf8")).toBe("{not json");
    expect(statusExtension().status.isEnabled()).toBe(true);
  });
});

describe("/pi-refuseless outside interactive Pi", () => {
  /** The command handler `registerRefuselessCommand` registers. */
  function command() {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const status: CreditsStatus = { isEnabled: () => true, setEnabled: () => undefined };
    registerRefuselessCommand(
      {
        registerCommand: (name: string, options: { handler: typeof handler }) => {
          expect(name).toBe("pi-refuseless");
          handler = options.handler;
        },
      } as unknown as ExtensionAPI,
      status,
    );
    return handler!;
  }
  const report = [
    "Refuseless credits",
    "  Available  $41.30",
    "  Balance    $42.50",
    "  Reserved   $1.20",
    "  Key limit  none",
  ];

  test("prints the balance to stderr without a UI", async () => {
    mock = await startMockRefuseless();
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    const ctx = { mode: "print", hasUI: false, modelRegistry: registry(mock.baseUrl) };
    await command()("", ctx as unknown as ExtensionCommandContext);
    expect(written).toStrictEqual([`${report.join("\n")}\n`]);
  });

  test("notifies the balance, a missing key or the error in RPC mode", async () => {
    let fail = false;
    mock = await startMockRefuseless({
      respond: (request, response) => {
        if (!fail || request.path !== "/v1/credits") return false;
        apiError(response, 401, "invalid_key", "Invalid API key.");
        return true;
      },
    });
    const notices: [string, string | undefined][] = [];
    const run = (key: string | null) =>
      command()("", {
        mode: "rpc",
        hasUI: true,
        modelRegistry: registry(mock!.baseUrl, key),
        ui: { notify: (message: string, level?: string) => notices.push([message, level]) },
      } as unknown as ExtensionCommandContext);
    await run(KEY);
    await run(null);
    fail = true;
    await run(KEY);
    expect(notices).toStrictEqual([
      [report.join("\n"), "info"],
      ["No Refuseless API key. Run /login and choose Refuseless.", "error"],
      [`GET ${mock.baseUrl}/credits failed with HTTP 401 (invalid_key: Invalid API key.)`, "error"],
    ]);
  });
});
