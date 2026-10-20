import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatResponse } from "../scripts/cli/mock-transport.ts";
import { accountsFilePath, createAccountCredentialStore } from "../src/accounts/credentials.ts";
import extension from "../src/index.ts";

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalKey = process.env.OLLAMA_API_KEY;
let temp: string;
let chatKeys: string[];

/** Start Pi with the extension on a session, send one prompt, and shut down like a process exit. */
async function runPiSession(sessionManager: SessionManager): Promise<void> {
  const agentDir = join(temp, "agent");
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: temp,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [extension],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: temp,
    agentDir,
    settingsManager,
    modelRuntime,
    resourceLoader: loader,
    sessionManager,
    noTools: "builtin",
  });
  try {
    await session.bindExtensions({ mode: "print" });
    await modelRuntime.setRuntimeApiKey("ollama-cloud", "key-default");
    const model = modelRuntime.getModel("ollama-cloud", "glm-5.3-flash");
    if (!model) throw new Error("Fixture model missing");
    await session.setModel(model);
    await session.prompt("1+1");
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
}

beforeEach(async () => {
  temp = mkdtempSync(join(tmpdir(), "ollama-session-lifecycle-"));
  process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
  delete process.env.OLLAMA_API_KEY;
  chatKeys = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/balance")) {
      return Response.json({ included: { balance_usd: 80, allowance_usd: 100 }, purchased: { balance_usd: 0 } });
    }
    if (url.endsWith("/chat/completions")) {
      chatKeys.push(new Headers(init?.headers).get("Authorization") ?? "");
      return chatResponse();
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const store = createAccountCredentialStore(accountsFilePath(join(temp, "agent")));
  await store.add("work", "key-work");
  await store.add("personal", "key-personal");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries({ PI_CODING_AGENT_DIR: originalAgentDir, OLLAMA_API_KEY: originalKey })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(temp, { recursive: true, force: true });
});

describe("session-sticky accounts in a real Pi session", () => {
  it("keeps a session's account across a restart and assigns the next account to a fork", async () => {
    const sessionDir = join(temp, "sessions");
    const first = SessionManager.create(temp, sessionDir);
    await runPiSession(first);
    const file = first.getSessionFile();
    if (!file) throw new Error("Session file missing");

    // Restarting Pi on the same session file keeps its account.
    await runPiSession(SessionManager.open(file, sessionDir));
    // A fork is a new session: it takes the next account in the rotation.
    await runPiSession(SessionManager.forkFrom(file, temp, sessionDir));
    // A brand-new session continues the rotation.
    await runPiSession(SessionManager.create(temp, sessionDir));

    expect(chatKeys).toEqual(["Bearer key-default", "Bearer key-default", "Bearer key-work", "Bearer key-personal"]);
  }, 30000);
});
