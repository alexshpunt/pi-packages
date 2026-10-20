import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolveCredential } from "../../../src/auth/resolver.ts";
import { CHAT_PROMPT, CHAT_TIMEOUT_MS, completeOllamaChat } from "../../../src/pi/chat.ts";
import { isWithinOutputBudget } from "../../../src/web/paging.ts";

export interface LiveReport {
  schemaVersion: 1;
  status: "running" | "pass" | "fail";
  startedAt: string;
  apiCallCounts: {
    chat: number;
    web_search: number;
    web_fetch: number;
    publicMetadata: number;
    balance: number;
    blocked: number;
  };
  checks: { name: string; result: "pass" | "fail"; observed: Record<string, unknown> }[];
}
function category(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|API key|credential/i.test(message)) return "authentication";
  if (/429|rate limit/i.test(message)) return "rate-limit";
  if (/timeout|120초|aborted|cancel/i.test(message)) return "timeout-or-cancellation";
  if (/shape|schema|payload|answer|budget/i.test(message)) return "contract";
  return "request-or-environment";
}
export async function runLiveVerification(options: {
  packageDir: string;
  includeChat: boolean;
  signal: AbortSignal;
  record?: (report: LiveReport) => void;
}): Promise<LiveReport> {
  const report: LiveReport = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    apiCallCounts: { chat: 0, web_search: 0, web_fetch: 0, publicMetadata: 0, balance: 0, blocked: 0 },
    checks: [],
  };
  const record = () => options.record?.(report);
  record();
  let active = "authentication";
  const originalFetch = globalThis.fetch;
  let temporary: string | undefined;
  const keys = ["PI_CODING_AGENT_DIR", "PI_OLLAMA_WEB_TOOLS", "PI_OLLAMA_SEARCH_CACHE_PATH"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    options.signal.throwIfAborted();
    const credential = await resolveCredential(options.signal);
    if (!credential.apiKey) throw new Error("No API key resolved");
    const apiKey = credential.apiKey;
    const modelId = "glm-5.3-flash:cloud";
    globalThis.fetch = async (input, init) => {
      options.signal.throwIfAborted();
      const url = new URL(input instanceof Request ? input.url : String(input));
      const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const count = report.apiCallCounts;
      const isCloud = url.origin === "https://ollama.com";
      let slot: "chat" | "web_search" | "web_fetch" | "publicMetadata" | "balance";
      if (isCloud && url.pathname === "/v1/chat/completions" && options.includeChat) {
        slot = "chat";
        if (payload.model !== modelId || payload.max_tokens !== 4096) throw new Error("Unexpected chat payload");
      } else if (isCloud && url.pathname === "/api/show" && options.includeChat && payload.model === modelId)
        slot = "publicMetadata";
      else if (
        isCloud &&
        url.pathname === "/api/web_search" &&
        payload.query === "Ollama Cloud" &&
        payload.max_results === 3
      )
        slot = "web_search";
      else if (isCloud && url.pathname === "/api/web_fetch" && payload.url === "https://ollama.com") slot = "web_fetch";
      // Purchased-credit protection checks the account balance once before the first web request.
      else if (isCloud && url.pathname === "/api/balance" && (init?.method ?? "GET") === "GET") slot = "balance";
      else {
        count.blocked += 1;
        record();
        throw new Error("Unexpected live endpoint or payload blocked");
      }
      if (count[slot] >= 1) {
        count.blocked += 1;
        record();
        throw new Error("Live request budget exhausted; retry blocked");
      }
      if (slot !== "publicMetadata" && new Headers(init?.headers).get("Authorization") !== `Bearer ${apiKey}`)
        throw new Error("Credential forwarding mismatch");
      count[slot] += 1;
      record();
      return originalFetch(input, { ...init, redirect: "error" });
    };
    if (options.includeChat) {
      active = "shared-cli-chat";
      const result = await completeOllamaChat(modelId, options.signal, async () => credential);
      if (!/\b2\b/.test(result.answer)) throw new Error("Unexpected answer");
      report.checks.push({
        name: active,
        result: "pass",
        observed: {
          model: modelId,
          question: CHAT_PROMPT,
          timeoutMs: CHAT_TIMEOUT_MS,
          maxTokens: 4096,
          answerContainsTwo: true,
          answerChars: result.answer.length,
          truncated: result.truncated,
        },
      });
      record();
    }
    temporary = await mkdtemp(join(tmpdir(), "ollama-live-"));
    const agentDir = join(temporary, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_OLLAMA_WEB_TOOLS = "1";
    process.env.PI_OLLAMA_SEARCH_CACHE_PATH = join(temporary, "cache.json");
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: temporary,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [options.packageDir],
      noExtensions: true,
      disabledBuiltinExtensions: ["mcp"],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    if (loader.getExtensions().errors.length) throw new Error("Artifact load failed");
    ({ session } = await createAgentSession({
      cwd: temporary,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(temporary),
      noTools: "builtin",
    }));
    await session.bindExtensions({ mode: "print" });
    await modelRuntime.setRuntimeApiKey("ollama-cloud", apiKey, { signal: options.signal });
    for (const name of ["ollama_web_search", "ollama_web_fetch"]) {
      active = name;
      options.signal.throwIfAborted();
      const tool = session.agent.state.tools.find((tool) => tool.name === name);
      if (!tool) throw new Error("Missing lifecycle tool");
      const params =
        name === "ollama_web_search" ? { query: "Ollama Cloud", max_results: 3 } : { url: "https://ollama.com" };
      const result = await tool.execute(`live-${name}`, params, options.signal);
      if (!isWithinOutputBudget(result)) throw new Error("Output budget exceeded");
      const details = result.details as {
        cacheRetained?: boolean;
        nextOffset?: number;
        totalChars?: number;
        totalResults?: number;
      };
      const observed: Record<string, unknown> = {
        serializedBytes: Buffer.byteLength(JSON.stringify(result)),
        totalChars: details.totalChars,
        totalResults: details.totalResults,
        cacheRetained: details.cacheRetained,
      };
      if (details.cacheRetained) {
        const before = JSON.stringify(report.apiCallCounts);
        // The transport budget is already exhausted for this endpoint: a miss is blocked before the wire.
        await tool.execute(`cached-${name}`, params, options.signal);
        if (name === "ollama_web_fetch" && details.nextOffset !== undefined)
          await tool.execute("cached-offset", { ...params, offset: details.nextOffset }, options.signal);
        if (JSON.stringify(report.apiCallCounts) !== before)
          throw new Error("Cache replay attempted an extra API request");
        observed.cacheReplayWithoutAPI = true;
      }
      report.checks.push({ name, result: "pass", observed });
      record();
    }
    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.checks.push({ name: active, result: "fail", observed: { category: category(error) } });
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (temporary) await rm(temporary, { recursive: true, force: true });
    record();
  }
  return report;
}
