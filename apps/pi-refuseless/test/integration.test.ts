/**
 * The user flow through Pi's own interactive mode: `/login` → Sign in with an API key → Refuseless →
 * key → the model list arrives from `GET /v1/models` → `/model` → prompt, plus restart, `/reload`,
 * cancellation and `/logout`. Requests go to the local mock. Set REFUSELESS_PACKAGE_DIR to check another
 * copy of the package, such as an extracted archive.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MOCK_CATALOG, type MockRefuseless, startMockRefuseless } from "../scripts/mock-refuseless.ts";
import { type InteractivePi, KEYS, startInteractivePi } from "./interactive-pi.ts";

const PACKAGE_DIR = process.env.REFUSELESS_PACKAGE_DIR ?? fileURLToPath(new URL("..", import.meta.url));
const CATALOG_IDS = MOCK_CATALOG.map((entry) => entry.id);
const UNRELATED = { unrelated: { type: "api_key", key: "unrelated-fake-key" } };
const TIMEOUT_MS = 60_000;

let directory: string;
let agentDir: string;
let mock: MockRefuseless;
const savedEnv: Record<string, string | undefined> = {};
const opened: InteractivePi[] = [];
// Requests leaving the machine; each test must end with none.
const realFetch = globalThis.fetch;
const external: string[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-refuseless-it-"));
  agentDir = join(directory, "agent");
  await mkdir(agentDir);
  mock = await startMockRefuseless();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("http://127.0.0.1:")) {
      external.push(url);
      throw new Error(`Blocked request to ${url}`);
    }
    return realFetch(input, init);
  });
  const env = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    REFUSELESS_API_KEY: undefined,
  };
  for (const [name, value] of Object.entries(env)) {
    savedEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterEach(async () => {
  for (const pi of opened.splice(0)) await pi.stop();
  await mock.close();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  expect(external.splice(0)).toStrictEqual([]);
});

async function start(packageDir: string | undefined = PACKAGE_DIR, otherProviders?: Record<string, unknown>) {
  const pi = await startInteractivePi({ agentDir, cwd: directory, packageDir, baseUrl: mock.baseUrl, otherProviders });
  opened.push(pi);
  return pi;
}

/**
 * A second configured provider, so a model fallback would be possible and visible. Its endpoint is a closed
 * port: if Pi ever routed a request there, the request would fail instead of silently succeeding.
 */
const OTHER_PROVIDER = {
  stub: {
    baseUrl: "http://127.0.0.1:1/v1",
    api: "openai-completions",
    apiKey: "stub-fake-key",
    models: [
      {
        id: "stub-model",
        name: "Stub",
        contextWindow: 200_000,
        maxTokens: 8_192,
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
};

async function stop(pi: InteractivePi) {
  opened.splice(opened.indexOf(pi), 1);
  await pi.stop();
}

const readAuth = async () => JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"));
const writeAuth = (value: object) => writeFile(join(agentDir, "auth.json"), JSON.stringify(value), { mode: 0o600 });
const refuselessProviders = (pi: InteractivePi) =>
  pi.runtime.services.modelRuntime.getProviders().filter((provider) => provider.id === "refuseless");
const modelIds = (pi: InteractivePi) =>
  pi.runtime.services.modelRuntime.getModels("refuseless").map((model) => model.id);
const chats = () => mock.requests.filter((request) => request.path === "/v1/chat/completions");

async function waitUntil(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** `/login` → Sign in with an API key → `name`, ending at its key prompt. */
async function openKeyPrompt(pi: InteractivePi, name = "Refuseless") {
  const { terminal } = pi;
  let mark = terminal.mark();
  await pi.submit("/login");
  await terminal.waitFor("Select authentication method:", mark);
  mark = terminal.mark();
  await terminal.type(KEYS.down);
  await terminal.type(KEYS.enter);
  await terminal.waitFor("Select provider to configure:", mark);
  mark = terminal.mark();
  await terminal.type(name);
  await terminal.waitFor(`→ ${name}`, mark);
  mark = terminal.mark();
  await terminal.type(KEYS.enter);
  await terminal.waitFor(`Enter ${name} API key`, mark);
}

/**
 * Escape at the key prompt. Pi either returns to the provider list or reports the aborted login
 * ("Failed to save API key for …"); either way the dialog closes. Returns which one happened.
 */
async function cancelKeyPrompt(pi: InteractivePi, name = "Refuseless") {
  const mark = pi.terminal.mark();
  await pi.terminal.type(KEYS.escape);
  const outcome = await pi.terminal.waitForAny(
    ["Select provider to configure:", `Failed to save API key for ${name}:`],
    mark,
  );
  if (outcome === "Select provider to configure:") await pi.terminal.type(KEYS.escape);
  return outcome === "Select provider to configure:" ? "back" : "aborted";
}

/** `/model`, filtered to `modelId`, then Enter once the list shows it; waits for Pi to report the selection. */
async function selectModel(pi: InteractivePi, modelId: string) {
  const { terminal } = pi;
  let mark = terminal.mark();
  await pi.submit("/model");
  await terminal.waitFor("Enter to select", mark);
  mark = terminal.mark();
  await terminal.type(modelId);
  await terminal.waitFor(`${modelId} [refuseless]`, mark);
  mark = terminal.mark();
  await terminal.type(KEYS.enter);
  await terminal.waitFor(`Model: ${modelId}`, mark);
  expect(pi.runtime.session.model).toMatchObject({ provider: "refuseless", id: modelId });
}

async function promptAndWait(pi: InteractivePi, text: string, reply: string) {
  const mark = pi.terminal.mark();
  await pi.submit(text);
  await pi.terminal.waitFor(reply, mark);
}

test(
  "native /login stores the key in Pi's auth.json, /model selects a model, and the request carries that key",
  async () => {
    await writeAuth(UNRELATED);
    // The same agent directory without the package; its models.json names refuseless only for the endpoint.
    const otherProviders = (pi: InteractivePi) =>
      pi.runtime.services.modelRuntime
        .getProviders()
        .map((provider) => provider.id)
        .filter((id) => id !== "refuseless");
    const baseline = await start(undefined);
    const baselineProviders = otherProviders(baseline);
    const baselineModel = baseline.runtime.session.model;
    await stop(baseline);

    const pi = await start();
    expect(otherProviders(pi)).toStrictEqual(baselineProviders);
    expect(refuselessProviders(pi)).toHaveLength(1);
    expect(modelIds(pi)).toStrictEqual([]);
    expect(pi.runtime.session.model).toStrictEqual(baselineModel);

    await openKeyPrompt(pi);
    const mark = pi.terminal.mark();
    await pi.terminal.type("  abl_tui-native-key  ");
    await pi.terminal.type(KEYS.enter);
    await pi.terminal.waitFor("Saved API key for Refuseless.", mark);
    expect(await readAuth()).toStrictEqual({
      ...UNRELATED,
      refuseless: { type: "api_key", key: "abl_tui-native-key" },
    });
    // Pi fetches the model list right after login, with the new key: every catalog model, abliterated or not.
    await waitUntil(() => modelIds(pi).length === CATALOG_IDS.length, "the model list arrives");
    expect(modelIds(pi)).toStrictEqual(CATALOG_IDS);
    expect(mock.requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/models",
      authorization: "Bearer abl_tui-native-key",
    });
    // Login neither selects a Refuseless model nor changes the saved default.
    expect(pi.runtime.session.model).toStrictEqual(baselineModel);
    expect(pi.runtime.services.settingsManager.getDefaultModel()).toBe(undefined);

    await selectModel(pi, "glm-5.3-flash-abliterated");
    await promptAndWait(pi, "Say ok.", "Mock Refuseless reply from glm-5.3-flash-abliterated");
    expect(
      chats().map(({ method, path, authorization, body }) => [method, path, authorization, body.model]),
    ).toStrictEqual([["POST", "/v1/chat/completions", "Bearer abl_tui-native-key", "glm-5.3-flash-abliterated"]]);

    // A fresh process on the same agent directory starts with the saved list and key, without another login.
    await stop(pi);
    const restarted = await start();
    expect(modelIds(restarted)).toStrictEqual(CATALOG_IDS);
    await selectModel(restarted, "minimax-m3.1-flash");
    await promptAndWait(restarted, "Say ok again.", "Mock Refuseless reply from minimax-m3.1-flash");
    expect(chats().at(-1)).toMatchObject({
      authorization: "Bearer abl_tui-native-key",
      body: { model: "minimax-m3.1-flash" },
    });
    expect(await readAuth()).toStrictEqual({
      ...UNRELATED,
      refuseless: { type: "api_key", key: "abl_tui-native-key" },
    });
  },
  TIMEOUT_MS,
);

test(
  "a new session starts a picked model at its reasoning_default, and a level the user chose carries over",
  async () => {
    await writeAuth({ refuseless: { type: "api_key", key: "abl_level-key" } });
    const pi = await start();
    const { terminal } = pi;
    const sent = () => chats().at(-1)?.body.reasoning_effort;

    // The session has no model, so its level is "off"; deepseek offers "off" but starts at its default.
    expect(pi.runtime.session.thinkingLevel).toBe("off");
    let mark = terminal.mark();
    await selectModel(pi, "deepseek-v4.1-flash-abliterated");
    await terminal.waitFor("deepseek-v4.1-flash-abliterated • low", mark);
    await promptAndWait(pi, "First.", "Mock Refuseless reply from deepseek-v4.1-flash-abliterated");
    expect(sent()).toBe("low");

    // Shift+Tab cycles low → high → max → off; the chosen off carries over to a model that offers it.
    for (const level of ["high", "max", "thinking off"]) {
      mark = terminal.mark();
      await terminal.type(KEYS.shiftTab);
      await terminal.waitFor(`deepseek-v4.1-flash-abliterated • ${level}`, mark);
    }
    await selectModel(pi, "deepseek-v4.1-flash-fast");
    expect(pi.runtime.session.thinkingLevel).toBe("off");
    await promptAndWait(pi, "Second.", "Mock Refuseless reply from deepseek-v4.1-flash-fast");
    expect(sent()).toBe("off");

    // glm offers no "off": Pi shows only its levels and moves the chosen off to the next one, low.
    await selectModel(pi, "glm-5.3-abliterated");
    expect(pi.runtime.session.thinkingLevel).toBe("low");
    expect(pi.runtime.session.getAvailableThinkingLevels()).toStrictEqual(["low", "high", "max"]);
    await promptAndWait(pi, "Third.", "Mock Refuseless reply from glm-5.3-abliterated");
    expect(sent()).toBe("low");
  },
  TIMEOUT_MS,
);

test(
  "every request uses the selected Refuseless model, and a restart restores it instead of another provider",
  async () => {
    await writeAuth({ refuseless: { type: "api_key", key: "abl_route-key" } });
    const picked = "glm-5.3-abliterated";
    const pi = await start(PACKAGE_DIR, OTHER_PROVIDER);

    // The other provider is configured, so Pi could fall back to it.
    expect(pi.runtime.services.modelRuntime.getModels("stub").map((model) => model.id)).toStrictEqual(["stub-model"]);
    expect(
      (await pi.runtime.services.modelRuntime.getAvailable()).map((model) => `${model.provider}/${model.id}`),
    ).toContain("stub/stub-model");

    await selectModel(pi, picked);
    await promptAndWait(pi, "First turn.", `Mock Refuseless reply from ${picked}`);
    // A tool round trip stays on the same model: the mock calls bash, Pi runs it and sends the result back.
    await promptAndWait(pi, "Use a tool please.", "Tool result:");
    expect(chats().length).toBeGreaterThanOrEqual(3);

    // Every chat request carried the selected model ID and the Refuseless key, and nothing else was sent.
    const sent = chats().map((request) => [request.body.model, request.authorization]);
    expect(sent).toStrictEqual(sent.map(() => [picked, "Bearer abl_route-key"]));
    expect(mock.requests.every((request) => request.path.startsWith("/v1/"))).toBe(true);
  },
  TIMEOUT_MS,
);

test(
  "a new session starts on the saved default model, so picking a model in /model does not carry over",
  async () => {
    await writeAuth({ refuseless: { type: "api_key", key: "abl_default-key" } });
    const picked = "glm-5.3-abliterated";
    // Pi's own rule: /model + Enter changes the current session, while the saved default (Ctrl+S) decides
    // what a new session starts on. Refuseless is not among Pi's built-in per-provider defaults.
    const otherIsDefault = { defaultProvider: "stub", defaultModel: "stub-model" };
    const first = await startInteractivePi({
      agentDir,
      cwd: directory,
      packageDir: PACKAGE_DIR,
      baseUrl: mock.baseUrl,
      otherProviders: OTHER_PROVIDER,
      settings: otherIsDefault,
    });
    opened.push(first);
    expect(first.runtime.session.model).toMatchObject({ provider: "stub", id: "stub-model" });
    await selectModel(first, picked);
    await promptAndWait(first, "On Refuseless.", `Mock Refuseless reply from ${picked}`);
    await stop(first);

    // The next session is back on the saved default, with the Refuseless list present and no warning.
    const next = await startInteractivePi({
      agentDir,
      cwd: directory,
      packageDir: PACKAGE_DIR,
      baseUrl: mock.baseUrl,
      otherProviders: OTHER_PROVIDER,
      settings: otherIsDefault,
    });
    opened.push(next);
    expect(modelIds(next)).toStrictEqual(CATALOG_IDS);
    expect(next.runtime.session.model).toMatchObject({ provider: "stub", id: "stub-model" });
    expect(next.runtime.modelFallbackMessage).toBe(undefined);
    // The footer names the active provider and model, which is how a user can tell them apart.
    await next.terminal.waitFor("(stub) stub-model", 0);

    // With the Refuseless model saved as the default, a new session starts on it.
    const saved = await startInteractivePi({
      agentDir,
      cwd: directory,
      packageDir: PACKAGE_DIR,
      baseUrl: mock.baseUrl,
      otherProviders: OTHER_PROVIDER,
      settings: { defaultProvider: "refuseless", defaultModel: picked },
    });
    opened.push(saved);
    expect(saved.runtime.session.model).toMatchObject({ provider: "refuseless", id: picked });
    await promptAndWait(saved, "Default session.", `Mock Refuseless reply from ${picked}`);
    expect(chats().at(-1)).toMatchObject({ authorization: "Bearer abl_default-key", body: { model: picked } });
  },
  TIMEOUT_MS,
);

test(
  "a rejected key is saved, but Pi warns that the model list could not be fetched and lists no models",
  async () => {
    const pi = await start();
    await openKeyPrompt(pi);
    const mark = pi.terminal.mark();
    await pi.terminal.type("wrong-key");
    await pi.terminal.type(KEYS.enter);
    await pi.terminal.waitFor("Saved API key for Refuseless, but its model catalog could not be refreshed", mark);
    expect(mock.requests).toMatchObject([{ method: "GET", path: "/v1/models", authorization: "Bearer wrong-key" }]);
    expect(modelIds(pi)).toStrictEqual([]);
  },
  TIMEOUT_MS,
);

test(
  "a cancelled first login saves nothing, and Escape behaves as for Pi's built-in key providers",
  async () => {
    await writeAuth(UNRELATED);
    const pi = await start();
    await openKeyPrompt(pi);
    const refuselessOutcome = await cancelKeyPrompt(pi);
    expect(await readAuth()).toStrictEqual(UNRELATED);
    expect(await pi.runtime.services.modelRuntime.getAuth("refuseless")).toBe(undefined);

    await openKeyPrompt(pi, "Cerebras");
    expect(await cancelKeyPrompt(pi, "Cerebras")).toBe(refuselessOutcome);
    expect(await readAuth()).toStrictEqual(UNRELATED);
  },
  TIMEOUT_MS,
);

test(
  "cancelled and blank key replacement keep the saved key, and /logout removes only Refuseless",
  async () => {
    const saved = { ...UNRELATED, refuseless: { type: "api_key", key: "abl_saved-key" } };
    await writeAuth(saved);
    const pi = await start();
    const { terminal } = pi;

    await openKeyPrompt(pi);
    await cancelKeyPrompt(pi);
    expect(await readAuth()).toStrictEqual(saved);

    await openKeyPrompt(pi);
    let mark = terminal.mark();
    await terminal.type("   ");
    await terminal.type(KEYS.enter);
    await terminal.waitFor("Failed to save API key for Refuseless: API key is empty", mark);
    expect(await readAuth()).toStrictEqual(saved);

    await selectModel(pi, "glm-5.3-flash-abliterated");
    await promptAndWait(pi, "Still there?", "Mock Refuseless reply from glm-5.3-flash-abliterated");
    expect(chats().at(-1)?.authorization).toBe("Bearer abl_saved-key");

    mark = terminal.mark();
    await pi.submit("/logout");
    await terminal.waitFor("Select provider to logout:", mark);
    mark = terminal.mark();
    await terminal.type("Refuseless");
    await terminal.type(KEYS.enter);
    await terminal.waitFor("Removed stored API key for Refuseless.", mark);
    expect(await readAuth()).toStrictEqual(UNRELATED);
    expect(await pi.runtime.services.modelRuntime.getAuth("refuseless")).toBe(undefined);
  },
  TIMEOUT_MS,
);

test(
  "/reload keeps one Refuseless registration, its models and the saved key",
  async () => {
    await writeAuth({ ...UNRELATED, refuseless: { type: "api_key", key: "abl_reload-key" } });
    const pi = await start();
    expect(refuselessProviders(pi)).toHaveLength(1);
    // With a saved key but no saved list, opening /model fetches the list.
    await selectModel(pi, "deepseek-v4.1-flash-abliterated");
    expect(modelIds(pi)).toStrictEqual(CATALOG_IDS);

    const mark = pi.terminal.mark();
    await pi.submit("/reload");
    await pi.terminal.waitFor("Reloaded keybindings, extensions", mark);
    expect(refuselessProviders(pi)).toHaveLength(1);
    // Pi restores the saved model list in the background after it registers the provider again.
    await vi.waitFor(() => expect(modelIds(pi)).toStrictEqual(CATALOG_IDS));
    expect(
      pi.runtime.services.modelRuntime.getModels("refuseless").every((model) => model.baseUrl === mock.baseUrl),
    ).toBe(true);

    await promptAndWait(pi, "After reload.", "Mock Refuseless reply from deepseek-v4.1-flash-abliterated");
    expect(chats().at(-1)?.authorization).toBe("Bearer abl_reload-key");
  },
  TIMEOUT_MS,
);
