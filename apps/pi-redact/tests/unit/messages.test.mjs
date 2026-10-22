import { createRedactor } from "@buyong/redact";
import { describe, expect, it } from "vitest";
import { createMaskEngine } from "../../dist/engine.js";
import { maskMessage, maskMessages, maskSessionEntriesInPlace, WITHHELD_TEXT } from "../../dist/messages.js";
import { REDACTION_MARKER } from "../../dist/render.js";
import { maskToolResult, withheldToolResult } from "../../dist/tool-results.js";
import { leakedSecrets } from "../support/fixtures.mjs";

const M = REDACTION_MARKER;
const engine = createMaskEngine(createRedactor());
const SECRET = "sk-abcdefghijklmnop1234";

/** An engine that fails on text containing FAIL, standing in for any masking failure. */
const failingEngine = {
  redactor: engine.redactor,
  maskText(text, filePath) {
    if (text.includes("FAIL")) throw new Error("masking failed");
    return engine.maskText(text, filePath);
  },
  maskJson(value) {
    if (JSON.stringify(value)?.includes("FAIL")) throw new Error("masking failed");
    return engine.maskJson(value);
  },
  labeled: (_label, mask) => mask(),
};

describe("maskMessage", () => {
  it("masks user, custom, and summary text", () => {
    expect(maskMessage(engine, { role: "user", content: `key ${SECRET}`, timestamp: 1 }).content).toBe(`key ${M}`);
    expect(
      maskMessage(engine, { role: "custom", customType: "x", content: [{ type: "text", text: SECRET }], display: true })
        .content,
    ).toEqual([{ type: "text", text: M }]);
    expect(maskMessage(engine, { role: "compactionSummary", summary: `saw ${SECRET}` }).summary).toBe(`saw ${M}`);
    expect(maskMessage(engine, { role: "branchSummary", summary: `saw ${SECRET}` }).summary).toBe(`saw ${M}`);
  });

  it("masks assistant text and tool-call arguments but keeps thinking, ids, and signatures", () => {
    const thinking = { type: "thinking", thinking: `I saw ${SECRET}`, thinkingSignature: "sig-AKIAIOSFODNN7EXAMPLE" };
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: `Use ${SECRET}`, textSignature: "text-sig" },
        thinking,
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: `curl -H 'Authorization: Bearer ${SECRET}'`, token: "plain" },
          thoughtSignature: "thought-sig",
        },
        { type: "toolCall", id: "call-2", name: "bash", arguments: {}, argumentsError: `bad json near ${SECRET}` },
      ],
    };
    const masked = maskMessage(engine, message);
    expect(masked.content[0]).toEqual({ type: "text", text: `Use ${M}`, textSignature: "text-sig" });
    expect(masked.content[1]).toBe(thinking);
    expect(masked.content[2]).toEqual({
      type: "toolCall",
      id: "call-1",
      name: "bash",
      arguments: { command: `curl -H 'Authorization: Bearer ${M}'`, token: M },
      thoughtSignature: "thought-sig",
    });
    expect(masked.content[3].argumentsError).toBe(`bad json near ${M}`);
    expect(message.content[0].text).toBe(`Use ${SECRET}`);
  });

  it("masks tool results and user shell output, keeping images and system messages", () => {
    const image = { type: "image", mimeType: "image/png", data: "AIzaSyA1234567890abcdefghijklmnopqrstu" };
    const result = maskMessage(engine, {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: `API_KEY=${SECRET}` }, image],
      isError: false,
    });
    expect(result.content).toEqual([{ type: "text", text: `API_KEY=${M}` }, image]);
    expect(result.toolCallId).toBe("call-1");
    const shell = maskMessage(engine, { role: "bashExecution", command: `echo ${SECRET}`, output: `PASSWORD=x\n` });
    expect([shell.command, shell.output]).toEqual([`echo ${M}`, `PASSWORD=${M}\n`]);
    const system = { role: "system", content: `key ${SECRET}`, sections: { project: SECRET } };
    expect(maskMessage(engine, system)).toBe(system);
  });
});

describe("maskMessages", () => {
  it("returns the same array when nothing is detected", () => {
    const messages = [{ role: "user", content: "hello", timestamp: 1 }];
    expect(maskMessages(engine, messages)).toEqual({ messages, withheldCount: 0 });
    expect(maskMessages(engine, messages).messages).toBe(messages);
  });

  it("scans a read result with the path the matching tool call read", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: ".env" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "DB_PASSWORD=two words" }],
      },
    ];
    expect(maskMessages(engine, messages).messages[1].content[0].text).toBe(`DB_PASSWORD=${M}`);
  });

  it("masks the rest of a request around malformed messages", () => {
    const malformed = [
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read" }] },
      { role: "assistant", content: null },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: undefined },
    ];
    const { messages, withheldCount } = maskMessages(engine, [...malformed, { role: "user", content: SECRET }]);
    expect(withheldCount).toBe(0);
    expect(messages.slice(0, 3)).toEqual(malformed);
    expect(messages[3].content).toBe(M);
  });

  it("withholds a message that cannot be masked instead of sending it", () => {
    const messages = [
      { role: "user", content: `key ${SECRET}` },
      {
        role: "toolResult",
        toolCallId: "call-9",
        toolName: "bash",
        content: [{ type: "text", text: `FAIL ${SECRET}` }],
        isError: false,
      },
      { role: "unknown-role", note: "FAIL" },
    ];
    const { messages: masked, withheldCount } = maskMessages(failingEngine, messages);
    expect(withheldCount).toBe(2);
    expect(masked).toHaveLength(2);
    expect(masked[0].content).toBe(`key ${M}`);
    expect(masked[1]).toMatchObject({ role: "toolResult", toolCallId: "call-9", toolName: "bash" });
    expect(masked[1].content).toEqual([{ type: "text", text: WITHHELD_TEXT }]);
  });
});

describe("maskSessionEntriesInPlace", () => {
  it("replaces entries with masked copies and leaves the originals unchanged", () => {
    const user = { type: "message", id: "1", parentId: null, message: { role: "user", content: `key ${SECRET}` } };
    const note = { type: "custom_message", id: "2", parentId: "1", customType: "x", content: SECRET, display: true };
    const summary = { type: "branch_summary", id: "3", parentId: "2", fromId: "1", summary: `saw ${SECRET}` };
    const model = { type: "model_change", id: "4", parentId: "3", provider: "p", modelId: "m" };
    const entries = [user, note, summary, model];
    const snapshot = structuredClone(entries);

    expect(maskSessionEntriesInPlace(engine, entries)).toBe(0);

    expect(entries[0].message.content).toBe(`key ${M}`);
    expect(entries[1].content).toBe(M);
    expect(entries[2].summary).toBe(`saw ${M}`);
    expect(entries[3]).toBe(model);
    expect([user, note, summary, model]).toEqual(snapshot);
  });

  it("withholds an entry that cannot be masked", () => {
    const entries = [
      { type: "message", id: "1", parentId: null, message: { role: "user", content: `FAIL ${SECRET}` } },
      { type: "message", id: "2", parentId: "1", message: { role: "unknown-role", note: "FAIL" } },
      { type: "compaction", id: "3", parentId: "2", summary: `FAIL ${SECRET}` },
    ];
    expect(maskSessionEntriesInPlace(failingEngine, entries)).toBe(3);
    expect(entries[0].message.content).toEqual([{ type: "text", text: WITHHELD_TEXT }]);
    expect(entries[1]).toEqual({ type: "custom", customType: "pi-redact-withheld", id: "2", parentId: "1" });
    expect(entries[2].summary).toBe(WITHHELD_TEXT);
    expect(leakedSecrets(entries, [SECRET])).toEqual([]);
  });
});

describe("maskToolResult", () => {
  const base = { type: "tool_result", toolCallId: "call-1", isError: false };

  it("accepts a result without content, as untyped tools may return", () => {
    expect(maskToolResult(engine, { ...base, toolName: "legacy", input: {}, content: undefined })).toBeUndefined();
    expect(
      maskToolResult(engine, { ...base, toolName: "legacy", input: {}, content: undefined, details: { secret: "x" } }),
    ).toEqual({ details: { secret: M } });
  });

  it("returns nothing for a clean result", () => {
    expect(
      maskToolResult(engine, {
        ...base,
        toolName: "bash",
        input: {},
        content: [{ type: "text", text: "ok" }],
        details: { exitCode: 0 },
      }),
    ).toBeUndefined();
  });

  it("masks content, details, and structured content together", () => {
    const result = maskToolResult(engine, {
      ...base,
      toolName: "bash",
      input: { command: "cat .env" },
      content: [{ type: "text", text: `API_KEY=${SECRET}` }],
      details: { truncation: null, fullOutputPath: "/tmp/out.log" },
      structuredContent: { output: `API_KEY=${SECRET}`, exit_code: 0 },
    });
    expect(result).toEqual({
      content: [{ type: "text", text: `API_KEY=${M}` }],
      structuredContent: { output: `API_KEY=${M}`, exit_code: 0 },
    });
  });

  it("keeps unchanged structured content when it replaces the content", () => {
    const structuredContent = { exit_code: 1 };
    const result = maskToolResult(engine, {
      ...base,
      toolName: "custom",
      input: {},
      content: [{ type: "text", text: `PASSWORD=x` }],
      structuredContent,
    });
    expect(result.structuredContent).toBe(structuredContent);
  });

  it("masks edit diffs in details and uses the read path as a hint", () => {
    const edit = maskToolResult(engine, {
      ...base,
      toolName: "edit",
      input: { path: ".env" },
      content: [{ type: "text", text: "Edited .env" }],
      details: { diff: "-API_TOKEN=old-value\n+API_TOKEN=new-value", firstChangedLine: 2 },
    });
    expect(edit).toEqual({
      details: { diff: `-API_TOKEN=${M}\n+API_TOKEN=${M}`, firstChangedLine: 2 },
    });
    const read = maskToolResult(engine, {
      ...base,
      toolName: "read",
      input: { path: "conf/app.env" },
      content: [{ type: "text", text: "DB_PASSWORD=two words" }],
      structuredContent: "DB_PASSWORD=two words",
    });
    expect(read.content).toEqual([{ type: "text", text: `DB_PASSWORD=${M}` }]);
    // The text copy for programmatic callers gets the same path hint, not just the first word masked.
    expect(read.structuredContent).toBe(`DB_PASSWORD=${M}`);
  });

  it("offers a withheld result that drops everything else", () => {
    expect(withheldToolResult()).toEqual({ content: [{ type: "text", text: WITHHELD_TEXT }], details: {}, isError: true });
  });
});
