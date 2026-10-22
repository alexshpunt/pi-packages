// The extension's hooks called directly, for paths a model session cannot easily reach.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalyticsStore, analyticsPath } from "../../dist/analytics.js";
import piRedact from "../../dist/index.js";
import { WITHHELD_TEXT } from "../../dist/messages.js";
import { REDACTION_MARKER } from "../../dist/render.js";
import { temporaryTree } from "../support/fixtures.mjs";

const M = REDACTION_MARKER;
const SECRET = "sk-abcdefghijklmnop1234";

/** Point the agent directory at a fresh tree for one test, with optional pi-redact settings. */
function useAgentDir(t, settings) {
  const agentDir = temporaryTree(t, settings === undefined ? {} : { "pi-redact/settings.json": settings });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.onTestFinished(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
  });
  return agentDir;
}

/**
 * The extension with recording fakes. The context is an RPC client: it has dialogs but no
 * terminal, so `/redact` shows its status as a notification and asks through `select`.
 */
function loadExtension(t, { branch = [], selections = [] } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  piRedact({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  });
  const notifications = [];
  const statuses = [];
  let aborted = false;
  const ctx = {
    cwd: temporaryTree(t),
    mode: "rpc",
    hasUI: true,
    isProjectTrusted: () => false,
    abort: () => {
      aborted = true;
    },
    sessionManager: { getSessionId: () => "session-1", getBranch: () => [...branch, ...entries] },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (key, text) => statuses.push({ key, text }),
      select: async (_title, choices) => {
        const wanted = selections.shift();
        return wanted === undefined ? undefined : choices.find((choice) => choice.startsWith(wanted));
      },
      theme: { fg: (_color, text) => text },
    },
  };
  return {
    handlers,
    commands,
    ctx,
    entries,
    notifications,
    statuses,
    wasAborted: () => aborted,
    emit: (name, event) => handlers.get(name)(event, ctx),
    run: (command) => commands.get(command).handler("", ctx),
  };
}

const toolResult = (overrides) => ({
  type: "tool_result",
  toolCallId: "call-1",
  toolName: "bash",
  input: {},
  content: [{ type: "text", text: `API_KEY=${SECRET}` }],
  details: undefined,
  isError: false,
  ...overrides,
});

describe("pi-redact hooks", () => {
  it("registers the hooks it relies on", (t) => {
    const { handlers, commands } = loadExtension(t);
    expect([...handlers.keys()].sort()).toEqual([
      "before_agent_start",
      "context_with_system",
      "session_before_compact",
      "session_before_tree",
      "session_shutdown",
      "session_start",
      "session_tree",
      "tool_call",
      "tool_result",
    ]);
    expect([...commands.keys()]).toEqual(["redact", "redact-custom", "redact-analytics"]);
  });

  it("masks top-level tool results and leaves nested calls to their parent", async (t) => {
    const { emit } = loadExtension(t);
    expect(await emit("tool_result", toolResult())).toEqual({ content: [{ type: "text", text: `API_KEY=${M}` }] });
    expect(await emit("tool_result", toolResult({ parentToolCallId: "parent" }))).toBeUndefined();
  });

  it("withholds a tool result whose masking fails", async (t) => {
    const { emit, notifications } = loadExtension(t);
    const details = {
      get output() {
        throw new Error("unreadable");
      },
    };
    expect(await emit("tool_result", toolResult({ details }))).toEqual({
      content: [{ type: "text", text: WITHHELD_TEXT }],
      details: {},
      isError: true,
    });
    expect(notifications).toEqual([
      { message: "pi-redact: masking failed for a bash result; the affected content was withheld instead of sent", level: "error" },
    ]);
  });

  it("aborts and sends nothing from the conversation when withholding itself fails", async (t) => {
    const { emit, wasAborted } = loadExtension(t);
    const system = { role: "system", content: "prompt" };
    const unreadable = {
      role: "user",
      get content() {
        throw new Error("unreadable");
      },
    };
    const result = await emit("context_with_system", { type: "context_with_system", messages: [system, unreadable] });
    expect(wasAborted()).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toBe(system);
    expect(result.messages[1]).toMatchObject({ role: "user", content: WITHHELD_TEXT });
  });

  it("returns nothing for a request with nothing to mask", async (t) => {
    const { emit } = loadExtension(t);
    const messages = [{ role: "system", content: `prompt ${SECRET}` }, { role: "user", content: "hello" }];
    expect(await emit("context_with_system", { type: "context_with_system", messages })).toBeUndefined();
  });

  it("adds the model guideline once", async (t) => {
    const { emit } = loadExtension(t);
    const event = { type: "before_agent_start", systemPromptOptions: { promptGuidelines: ["existing"] } };
    await emit("before_agent_start", event);
    await emit("before_agent_start", event);
    expect(event.systemPromptOptions.promptGuidelines).toHaveLength(2);
    expect(event.systemPromptOptions.promptGuidelines[1]).toContain(`Text shown as ${M}`);
  });

  it("masks compaction input without changing the session's messages", async (t) => {
    const { emit } = loadExtension(t);
    const original = { role: "user", content: `key ${SECRET}` };
    const preparation = {
      messagesToSummarize: [original],
      turnPrefixMessages: [{ role: "bashExecution", command: "cat .env", output: `API_KEY=${SECRET}` }],
      previousSummary: `earlier ${SECRET}`,
    };
    expect(await emit("session_before_compact", { type: "session_before_compact", preparation })).toBeUndefined();
    expect(preparation.messagesToSummarize[0].content).toBe(`key ${M}`);
    expect(preparation.turnPrefixMessages[0].output).toBe(`API_KEY=${M}`);
    expect(preparation.previousSummary).toBe(`earlier ${M}`);
    expect(original.content).toBe(`key ${SECRET}`);
  });

  it("cancels compaction rather than sending input it could not mask", async (t) => {
    const { emit } = loadExtension(t);
    const preparation = {
      get messagesToSummarize() {
        throw new Error("unreadable");
      },
      turnPrefixMessages: [],
    };
    expect(await emit("session_before_compact", { type: "session_before_compact", preparation })).toEqual({
      cancel: true,
    });
  });

  it("masks branch summary entries only when a summary is requested", async (t) => {
    const { emit } = loadExtension(t);
    const entry = { type: "message", id: "1", parentId: null, message: { role: "user", content: `key ${SECRET}` } };
    const skipped = { userWantsSummary: false, entriesToSummarize: [entry] };
    await emit("session_before_tree", { type: "session_before_tree", preparation: skipped });
    expect(skipped.entriesToSummarize[0]).toBe(entry);
    const summarized = { userWantsSummary: true, entriesToSummarize: [entry] };
    await emit("session_before_tree", { type: "session_before_tree", preparation: summarized });
    expect(summarized.entriesToSummarize[0].message.content).toBe(`key ${M}`);
    expect(entry.message.content).toBe(`key ${SECRET}`);
  });

  it("blocks a call that writes the marker and tells the user", async (t) => {
    const { emit, notifications } = loadExtension(t);
    const result = await emit("tool_call", {
      type: "tool_call",
      toolCallId: "c",
      toolName: "bash",
      input: { command: `echo ${M}` },
    });
    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("pi-redact blocked this call");
    expect(notifications.at(-1)).toEqual({ message: `pi-redact blocked writing ${M} to bash command`, level: "warning" });
  });

  it("reports settings problems at session start and on the /redact page", async (t) => {
    const loaded = loadExtension(t);
    const agentDir = useAgentDir(t, "{ not json");
    await loaded.emit("session_start", { type: "session_start" });
    expect(loaded.notifications).toEqual([
      { message: `pi-redact: ${agentDir}/pi-redact/settings.json: is not valid JSON`, level: "warning" },
    ]);
    await loaded.emit("tool_result", toolResult());
    await loaded.run("redact");
    const status = loaded.notifications.at(-1).message;
    expect(status).toContain("Masking is on (this session follows the global default).");
    expect(status).toContain("Settings: built-in rules only");
    expect(status).toContain("Skipped:");
    expect(status).toContain("1 tool results masked");
    expect(status).toContain("Analytics: 1 records in this session");
  });

  it("turns masking off for one session, keeps the write guard, and shows it in the status bar", async (t) => {
    useAgentDir(t);
    const loaded = loadExtension(t, { selections: ["This session"] });
    await loaded.emit("session_start", { type: "session_start" });
    await loaded.run("redact");
    expect(loaded.entries).toEqual([{ type: "custom", customType: "pi-redact-session", data: { version: 1, enabled: false } }]);
    expect(loaded.statuses.at(-1)).toEqual({ key: "pi-redact", text: "redact off (this session)" });

    expect(await loaded.emit("tool_result", toolResult())).toBeUndefined();
    const messages = [{ role: "user", content: `key ${SECRET}` }];
    expect(await loaded.emit("context_with_system", { type: "context_with_system", messages })).toBeUndefined();
    const blocked = await loaded.emit("tool_call", {
      type: "tool_call",
      toolCallId: "c",
      toolName: "bash",
      input: { command: `echo ${M}` },
    });
    expect(blocked).toMatchObject({ block: true });
  });

  it("restores the session's own choice from its branch", async (t) => {
    useAgentDir(t);
    const choice = { type: "custom", customType: "pi-redact-session", data: { version: 1, enabled: false } };
    const loaded = loadExtension(t, { branch: [choice] });
    await loaded.emit("session_start", { type: "session_start" });
    expect(await loaded.emit("tool_result", toolResult())).toBeUndefined();
  });

  it("follows a global default of off unless the session turns masking on", async (t) => {
    useAgentDir(t, JSON.stringify({ enabled: false }));
    const loaded = loadExtension(t, { selections: ["This session"] });
    await loaded.emit("session_start", { type: "session_start" });
    expect(loaded.statuses.at(-1)).toEqual({ key: "pi-redact", text: "redact off" });
    expect(await loaded.emit("tool_result", toolResult())).toBeUndefined();
    await loaded.run("redact");
    expect(loaded.statuses.at(-1)).toEqual({ key: "pi-redact", text: undefined });
    expect(await loaded.emit("tool_result", toolResult())).toEqual({ content: [{ type: "text", text: `API_KEY=${M}` }] });
  });

  it("saves the global default to the settings file and applies it at once", async (t) => {
    const agentDir = useAgentDir(t, JSON.stringify({ sensitiveFields: ["OPENAI_KEY"] }));
    const loaded = loadExtension(t, { selections: ["Global default"] });
    await loaded.emit("session_start", { type: "session_start" });
    await loaded.run("redact");
    const saved = JSON.parse(readFileSync(join(agentDir, "pi-redact/settings.json"), "utf8"));
    expect(saved).toEqual({ enabled: false, sensitiveFields: ["OPENAI_KEY"] });
    expect(await loaded.emit("tool_result", toolResult())).toBeUndefined();
  });

  it("edits the settings as JSON in Pi's editor dialog without a terminal", async (t) => {
    const agentDir = useAgentDir(t);
    const loaded = loadExtension(t);
    const edits = ["{ not json", JSON.stringify({ disabledRules: ["token.nope"] }), JSON.stringify({ sensitiveFields: ["OPENAI_KEY"] })];
    loaded.ctx.ui.editor = async () => edits.shift();
    await loaded.emit("session_start", { type: "session_start" });
    await loaded.run("redact-custom");

    expect(loaded.notifications.map(({ message }) => message)).toEqual([
      "The text is not valid JSON; nothing was saved.",
      "Nothing was saved: disabledRules[0]: is not a built-in rule id",
      `Saved ${join(agentDir, "pi-redact/settings.json")}.`,
    ]);
    const result = await loaded.emit("tool_result", toolResult({ content: [{ type: "text", text: "OPENAI_KEY=abc" }] }));
    expect(result).toEqual({ content: [{ type: "text", text: `OPENAI_KEY=${M}` }] });
  });

  it("records the original and masked lines of what it masked", async (t) => {
    const agentDir = useAgentDir(t);
    const loaded = loadExtension(t);
    await loaded.emit("session_start", { type: "session_start" });
    await loaded.emit("tool_result", toolResult({ toolName: "read", input: { path: ".env" } }));
    // The same text in the next request is already masked and adds no record.
    const messages = [{ role: "user", content: `key ${SECRET}` }];
    await loaded.emit("context_with_system", { type: "context_with_system", messages });
    await loaded.emit("context_with_system", { type: "context_with_system", messages });

    const store = new AnalyticsStore(analyticsPath(agentDir));
    t.onTestFinished(() => store.close());
    const records = store.list({ sessionId: "session-1" }, 10);
    expect(records.map(({ source, label, ruleIds }) => ({ source, label, ruleIds }))).toEqual([
      { source: "model request", label: "user message", ruleIds: ["token.openai"] },
      { source: "tool result", label: "read .env", ruleIds: ["field.sensitive", "token.openai"] },
    ]);
    expect(store.get(records[1].id).excerpt.lines).toEqual([{ line: 1, before: `API_KEY=${SECRET}`, after: `API_KEY=${M}` }]);

    await loaded.run("redact-analytics");
    const text = loaded.notifications.at(-1).message;
    expect(text).toContain(`-1 API_KEY=${SECRET}`);
    expect(text).toContain(`+1 API_KEY=${M}`);
  });
});
