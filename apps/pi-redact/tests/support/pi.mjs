// A real Pi AgentSession with this package loaded through its manifest. Model calls go to a
// scripted stream function that records every request, including compaction and summaries.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { temporaryTree } from "./fixtures.mjs";

/** The package Pi loads; set PI_REDACT_PACKAGE_DIR to check an installed artifact instead of this checkout. */
export const PACKAGE_DIR = process.env.PI_REDACT_PACKAGE_DIR ?? fileURLToPath(new URL("../../", import.meta.url));

let hostAi;
/** The pi-ai copy that pi-coding-agent itself loads, so stream classes match. */
async function hostAI() {
  if (hostAi) return hostAi;
  let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  for (let depth = 0; depth < 8; depth++) {
    try {
      const manifestPath = join(dir, "node_modules/@earendil-works/pi-ai/package.json");
      if (JSON.parse(await readFile(manifestPath, "utf8")).name === "@earendil-works/pi-ai") {
        hostAi = await import(pathToFileURL(join(dir, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
        return hostAi;
      }
    } catch {}
    dir = dirname(dir);
  }
  throw new Error("Pi's pi-ai dependency was not found");
}

const MODEL = {
  id: "fixture-model",
  name: "Fixture model",
  provider: "fixture",
  api: "openai-completions",
  baseUrl: "http://unused.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 2_000,
};

async function offlineModelRuntime(agentDir) {
  const { InMemoryCredentialStore } = await hostAI();
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.refresh = async () => ({ aborted: false, errors: new Map() });
  runtime.registerProvider("fixture", {
    baseUrl: MODEL.baseUrl,
    api: MODEL.api,
    apiKey: "synthetic-fixture-key",
    models: [
      {
        id: MODEL.id,
        name: MODEL.name,
        reasoning: false,
        input: ["text"],
        cost: MODEL.cost,
        contextWindow: MODEL.contextWindow,
        maxTokens: MODEL.maxTokens,
      },
    ],
  });
  return runtime;
}

function assistantMessage(content, stopReason) {
  return {
    role: "assistant",
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    content,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * Start a session in a fresh workspace. `files` go into the workspace, `globalSettings`
 * into the agent directory's pi-redact settings, `extensions` are extra extension files.
 */
export async function startSession(t, { files = {}, globalSettings, extensions = [] } = {}) {
  const root = temporaryTree(t, Object.fromEntries(Object.entries(files).map(([path, text]) => [`workspace/${path}`, text])));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.onTestFinished(() => {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  if (globalSettings !== undefined) {
    mkdirSync(join(agentDir, "pi-redact"), { recursive: true });
    writeFileSync(join(agentDir, "pi-redact", "settings.json"), JSON.stringify(globalSettings));
  }

  const settingsManager = SettingsManager.inMemory(
    {
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false, keepRecentTokens: 1 },
      retry: { enabled: false },
      quietStartup: true,
    },
    { projectTrusted: false },
  );
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [PACKAGE_DIR, ...extensions],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: [],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length) throw new Error(`Extension load failed: ${JSON.stringify(loaded.errors)}`);

  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir,
    modelRuntime: await offlineModelRuntime(agentDir),
    model: MODEL,
    thinkingLevel: "off",
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.create(workspace, sessionDir),
  });
  const extensionErrors = [];
  await session.bindExtensions({
    mode: "print",
    onError: (error) => extensionErrors.push(error),
  });
  t.onTestFinished(() => session.dispose());

  const { createAssistantMessageEventStream } = await hostAI();
  /** Every context the model received, in order. */
  const requests = [];
  const plan = [];
  let callIndex = 0;
  session.agent.streamFunction = async (_model, context) => {
    requests.push(structuredClone(context));
    callIndex++;
    const calls = plan.shift();
    const message = calls?.length
      ? assistantMessage(
          calls.map((call, index) => ({
            type: "toolCall",
            id: `call-${callIndex}-${index}`,
            name: call.name,
            arguments: call.args,
          })),
          "toolUse",
        )
      : assistantMessage([{ type: "text", text: calls === undefined ? "Fixture summary." : "Done." }], "stop");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
    });
    return stream;
  };

  return {
    session,
    workspace,
    requests,
    extensionErrors,
    /** Script the next turn: each step is a list of tool calls, `[]` ends with a text reply. */
    plan(steps) {
      plan.push(...steps);
    },
    sessionEntries() {
      const file = session.sessionManager.getSessionFile();
      return readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
  };
}

/** Messages of a request except system messages, which pi-redact leaves unchanged. */
export function conversationOf(request) {
  return request.messages.filter((message) => message.role !== "system");
}

export function systemOf(request) {
  return request.messages.filter((message) => message.role === "system");
}
