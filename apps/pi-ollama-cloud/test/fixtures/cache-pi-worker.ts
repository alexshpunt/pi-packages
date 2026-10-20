import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadCache } from "../../src/cache/storage.ts";
import extension from "../../src/index.ts";

const [path, key] = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!path || !key || !agentDir || !process.send) throw new Error("Expected isolated Pi fixture parameters.");
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
const counts = { web_fetch: 0, web_search: 0, balance: 0, unexpected: 0 };
globalThis.fetch = async (url) => {
  await delay(20);
  // Purchased-credit protection checks the balance once before the first request.
  if (String(url).endsWith("/api/balance")) {
    counts.balance += 1;
    return Response.json({ included: { balance_usd: 50, allowance_usd: 60 }, purchased: { balance_usd: 0 } });
  }
  if (String(url).endsWith("/api/web_fetch")) {
    counts.web_fetch += 1;
    return Response.json({ title: key, content: "fixture", links: [] });
  }
  if (String(url).endsWith("/api/web_search")) {
    counts.web_search += 1;
    return Response.json({ results: [{ title: key, url: `https://example.test/${key}`, content: "fixture" }] });
  }
  counts.unexpected += 1;
  throw new Error("Unexpected fixture transport");
};
loadCache();
const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: null,
  modelsStorePath: join(agentDir, "models.json"),
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const loader = new DefaultResourceLoader({
  cwd: agentDir,
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
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({
  cwd: agentDir,
  agentDir,
  settingsManager,
  modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(agentDir),
  noTools: "builtin",
});
await session.bindExtensions({ mode: "print" });
await modelRuntime.setRuntimeApiKey("ollama-cloud", "fixture");
process.send({ event: "ready" });
process.on("message", async (message: unknown) => {
  if (message !== "write") return;
  try {
    const fetchTool = session.agent.state.tools.find((tool) => tool.name === "ollama_web_fetch");
    const searchTool = session.agent.state.tools.find((tool) => tool.name === "ollama_web_search");
    assert.ok(fetchTool);
    assert.ok(searchTool);
    await Promise.all([
      fetchTool.execute("fetch-1", { url: `https://example.test/${key}` }),
      fetchTool.execute("fetch-2", { url: `https://example.test/${key}`, full: true }),
      searchTool.execute("search-1", { query: key, max_results: 3 }),
      searchTool.execute("search-2", { query: key, max_results: 3, expand: 1 }),
    ]);
    assert.deepEqual(counts, { web_fetch: 1, web_search: 1, balance: 1, unexpected: 0 });
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    process.send?.({ event: "done", counts });
  } catch (error) {
    console.error(error);
    process.send?.({ event: "error" });
  }
});
