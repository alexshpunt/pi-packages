// The extension's hooks called directly, for paths a model session cannot easily reach.
import { describe, expect, it } from "vitest";
import piRedact from "../../dist/index.js";
import { WITHHELD_TEXT } from "../../dist/messages.js";
import { REDACTION_MARKER } from "../../dist/render.js";
import { temporaryTree } from "../support/fixtures.mjs";

const M = REDACTION_MARKER;
const SECRET = "sk-abcdefghijklmnop1234";

function loadExtension(t) {
  const handlers = new Map();
  const commands = new Map();
  piRedact({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  });
  const notifications = [];
  let aborted = false;
  const ctx = {
    cwd: temporaryTree(t),
    hasUI: true,
    isProjectTrusted: () => false,
    abort: () => {
      aborted = true;
    },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  };
  return {
    handlers,
    commands,
    ctx,
    notifications,
    wasAborted: () => aborted,
    emit: (name, event) => handlers.get(name)(event, ctx),
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
      "session_start",
      "tool_call",
      "tool_result",
    ]);
    expect([...commands.keys()]).toEqual(["pi-redact"]);
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

  it("reports settings problems at session start and in the status command", async (t) => {
    const loaded = loadExtension(t);
    const agentDir = temporaryTree(t, { "pi-redact/settings.json": "{ not json" });
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.onTestFinished(() => {
      process.env.PI_CODING_AGENT_DIR = previous;
    });
    await loaded.emit("session_start", { type: "session_start" });
    expect(loaded.notifications).toEqual([
      { message: `pi-redact: ${agentDir}/pi-redact/settings.json: is not valid JSON`, level: "warning" },
    ]);
    await loaded.emit("tool_result", toolResult());
    await loaded.commands.get("pi-redact").handler("", loaded.ctx);
    const status = loaded.notifications.at(-1).message;
    expect(status).toContain("Settings: built-in rules only");
    expect(status).toContain("Skipped:");
    expect(status).toContain("1 tool results masked");
  });
});
