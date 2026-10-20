import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, visibleWidth } from "@earendil-works/pi-tui";
import { chatResponse } from "../../scripts/cli/mock-transport.ts";
import { type createPagedResult, isWithinOutputBudget } from "../../src/web/paging.ts";

type Page = ReturnType<typeof createPagedResult>;
const [packageDir, profile = "enabled"] = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = process.env.VERIFY_WORK_DIR;
assert.ok(packageDir && agentDir && cwd);
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(cwd, ".pi"), { recursive: true });
writeFileSync(
  join(cwd, ".pi", "ollama-cloud.json"),
  JSON.stringify({ webTools: profile !== "soft-disabled", usageStatus: true }),
);
initTheme("dark", false);
const counts = { chat: 0, search: 0, fetch: 0, balance: 0, usage: 0, unexpected: 0 };
const body = "fixture body 한글🙂\n".repeat(600);
const bigBody = "가🙂".repeat(30000);
let failureStatus = 404;
let hasSlowStarted = false;
let finishSlowStart!: () => void;
const slowStarted = new Promise<void>((resolve) => {
  finishSlowStart = resolve;
});
let chatMode: "reply" | "invalid-tool" = "reply";
let capturedPayload: Record<string, unknown> | undefined;
globalThis.fetch = async (url, init) => {
  const address = url instanceof Request ? url.url : String(url);
  const payload = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture");
  if (address.endsWith("/chat/completions")) {
    counts.chat += 1;
    if (chatMode === "invalid-tool") {
      chatMode = "reply";
      const data = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "invalid-fixture",
                  type: "function",
                  function: {
                    name: "ollama_web_search",
                    arguments: JSON.stringify({ query: "fixture", max_results: 11 }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
      return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    capturedPayload = payload;
    return chatResponse();
  }
  if (address.endsWith("/api/web_search")) {
    counts.search += 1;
    assert.equal(payload.query, "fixture");
    assert.equal(payload.max_results, 3);
    return Response.json({ results: [{ title: "fixture", url: "https://example.test/page", content: body }] });
  }
  if (address.endsWith("/api/web_fetch")) {
    counts.fetch += 1;
    if (payload.url === "https://example.test/slow") {
      hasSlowStarted = true;
      finishSlowStart();
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("fixture aborted", "AbortError")), {
          once: true,
        });
      });
    }
    if (payload.url === "https://example.test/failure" && failureStatus !== 200)
      return new Response("fixture failure", { status: failureStatus });
    return Response.json({
      title: "fixture",
      content: payload.url === "https://example.test/big" ? bigBody : body,
      links: [],
    });
  }
  if (address.endsWith("/api/balance")) {
    // Purchased-credit protection checks the account balance before its first request.
    counts.balance += 1;
    return Response.json({ included: { balance_usd: 50, allowance_usd: 60 }, purchased: { balance_usd: 0 } });
  }
  if (/\/api\/usage/.test(address)) counts.usage += 1;
  else counts.unexpected += 1;
  throw new Error("Unexpected fixture request");
};
const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: null,
  modelsStorePath: join(agentDir, "models.json"),
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  additionalExtensionPaths: [packageDir],
  noExtensions: true,
  disabledBuiltinExtensions: ["mcp"],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
assert.equal(loader.getExtensions().extensions.length, 1);
const factoryTools = [...loader.getExtensions().extensions[0].tools.keys()];
assert.deepEqual(factoryTools, []);
const { session } = await createAgentSession({
  cwd,
  agentDir,
  settingsManager,
  modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
  noTools: "builtin",
});
const extensionErrors: unknown[] = [];
try {
  await session.bindExtensions({
    mode: "print",
    onError: (error) => {
      extensionErrors.push(error);
    },
  });
  await modelRuntime.setRuntimeApiKey("ollama-cloud", "fixture");
  const model = modelRuntime.getModel("ollama-cloud", "glm-5.3-flash");
  assert.ok(model);
  await session.setModel(model);
  assert.deepEqual(modelRuntime.getRegisteredProviderIds(), ["ollama-cloud"]);
  const commands = [...loader.getExtensions().extensions[0].commands.keys()].sort();
  const expectedCommands = ["ollama"];
  assert.deepEqual(commands, expectedCommands);
  const toolsAtStart = session.getActiveToolNames().sort();
  assert.deepEqual(toolsAtStart, profile === "enabled" ? ["ollama_web_fetch", "ollama_web_search"] : []);
  // Without the TUI, /ollama prints a settings summary and accepts toggle arguments.
  await session.prompt("/ollama");
  if (profile !== "hard-disabled") {
    await session.prompt("/ollama webtools on");
    assert.deepEqual(session.getActiveToolNames().sort(), ["ollama_web_fetch", "ollama_web_search"]);
    await session.prompt("/ollama webtools off");
    assert.deepEqual(session.getActiveToolNames(), []);
    await session.prompt("/ollama webtools on");
  } else {
    // PI_OLLAMA_WEB_TOOLS=off is a hard kill switch the setting cannot override.
    await session.prompt("/ollama webtools on");
    assert.deepEqual(session.getActiveToolNames(), []);
  }
  await session.prompt("/ollama status on");
  await session.prompt("/ollama status off");
  // Toggles are saved to the global config so the next Pi start uses them.
  const savedSettings = JSON.parse(readFileSync(join(agentDir, "ollama-cloud.json"), "utf8")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(
    savedSettings,
    profile === "hard-disabled" ? { usageStatus: false } : { webTools: true, usageStatus: false },
  );
  let maxResultBytes = 0;
  let hasValidatedInput = false;
  let hasCanceled = false;
  const renderWidths: number[] = [];
  let payloadSummary: Record<string, unknown> | undefined;
  if (profile === "enabled") {
    let sequence = 0;
    const execute = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const tool = session.agent.state.tools.find((tool) => tool.name === name);
      assert.ok(tool);
      const result = (await tool.execute(`fixture-${++sequence}`, args, signal)) as Page;
      assert.ok(isWithinOutputBudget(result));
      maxResultBytes = Math.max(maxResultBytes, Buffer.byteLength(JSON.stringify(result)));
      return result;
    };
    const searchArgs = { query: "fixture", max_results: 3 };
    await execute("ollama_web_search", searchArgs);
    await execute("ollama_web_search", searchArgs);
    await execute("ollama_web_search", { ...searchArgs, expand: 1 });
    assert.equal(counts.search, 1);
    await execute("ollama_web_search", { ...searchArgs, refresh: true });
    assert.equal(counts.search, 2);
    const first = await execute("ollama_web_fetch", { url: "https://example.test/page" });
    await execute("ollama_web_fetch", { url: "https://example.test/page", offset: first.details.nextOffset });
    await execute("ollama_web_fetch", { url: "https://example.test/page", full: true });
    assert.equal(counts.fetch, 1);
    await execute("ollama_web_fetch", { url: "https://example.test/page", refresh: true });
    assert.equal(counts.fetch, 2);
    let offset = 0;
    let complete = "";
    let big: Page | undefined;
    for (let page = 0; page < 10; page++) {
      big = await execute("ollama_web_fetch", { url: "https://example.test/big", full: true, offset });
      complete += big.content[0].text.slice(big.details.bodyStart, big.details.bodyEnd);
      if (big.details.nextOffset === undefined) break;
      offset = big.details.nextOffset;
    }
    assert.equal(complete, bigBody);
    assert.equal(counts.fetch, 3);
    const failureArgs = { url: "https://example.test/failure" };
    await assert.rejects(execute("ollama_web_fetch", failureArgs), /404/);
    await assert.rejects(execute("ollama_web_fetch", failureArgs), /404/);
    assert.equal(counts.fetch, 4);
    failureStatus = 500;
    await assert.rejects(execute("ollama_web_fetch", { ...failureArgs, refresh: true }), /500/);
    failureStatus = 200;
    await execute("ollama_web_fetch", failureArgs);
    assert.equal(counts.fetch, 6);
    const controller = new AbortController();
    const slow = execute("ollama_web_fetch", { url: "https://example.test/slow" }, controller.signal);
    await slowStarted;
    assert.equal(hasSlowStarted, true);
    const rejected = assert.rejects(slow);
    controller.abort();
    await rejected;
    hasCanceled = true;
    const definition = session.getToolDefinition("ollama_web_fetch");
    assert.ok(definition?.renderResult && big);
    const context: Parameters<NonNullable<ToolDefinition["renderResult"]>>[3] = {
      args: { url: "https://example.test/big" },
      toolCallId: "fixture-render",
      cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      durationMs: 0,
      outputPad: 1,
      state: {},
      lastComponent: new Container(),
      isError: false,
      invalidate() {},
    };
    const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
    for (const expanded of [false, true, false])
      for (const width of [40, 80]) {
        context.expanded = expanded;
        const component: Component | undefined = definition.renderResult(
          big,
          { expanded, isPartial: false },
          theme,
          context,
        );
        assert.ok(component);
        context.lastComponent = component;
        assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
        renderWidths.push(width);
      }
    const reply = await modelRuntime.completeSimple(
      model,
      { messages: [{ role: "user", content: "fixture payload", timestamp: 1 }] },
      { maxTokens: 321, reasoning: "low", maxRetries: 0 },
    );
    assert.equal(reply.stopReason, "stop");
    assert.ok(capturedPayload);
    assert.equal(capturedPayload.model, "glm-5.3-flash");
    assert.equal(capturedPayload.max_tokens, 321);
    assert.equal(capturedPayload.reasoning_effort, "low");
    assert.equal(capturedPayload.provider, undefined);
    payloadSummary = {
      model: capturedPayload.model,
      max_tokens: capturedPayload.max_tokens,
      reasoning_effort: capturedPayload.reasoning_effort,
      hasProvider: Object.hasOwn(capturedPayload, "provider"),
    };
    const beforeSearch = counts.search;
    session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "ollama_web_search" && event.isError)
        hasValidatedInput = true;
    });
    chatMode = "invalid-tool";
    await session.agent.prompt("fixture invalid query");
    assert.equal(hasValidatedInput, true);
    assert.equal(counts.search, beforeSearch);
  }
  assert.equal(counts.usage, 0);
  assert.equal(counts.unexpected, 0);
  // One check serves every later request while the recorded balance stays fresh.
  assert.equal(counts.balance, profile === "enabled" ? 1 : 0);
  await session.reload();
  assert.deepEqual(extensionErrors, []);
  assert.equal(counts.usage, 0);
  assert.equal(counts.unexpected, 0);
  assert.deepEqual(modelRuntime.getRegisteredProviderIds(), ["ollama-cloud"]);
  assert.equal(loader.getExtensions().extensions.length, 1);
  assert.deepEqual(
    session.getActiveToolNames().sort(),
    profile === "enabled" ? ["ollama_web_fetch", "ollama_web_search"] : [],
  );
  console.log(
    `CONTRACT_RESULT=${JSON.stringify({ profile, providers: ["ollama-cloud"], commands, factoryTools, toolsAtStart, counts, maxResultBytes, hasValidatedInput, hasCanceled, renderWidths, payload: payloadSummary, hasReloaded: true })}`,
  );
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
