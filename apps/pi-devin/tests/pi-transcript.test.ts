import { expect, test } from "vitest";
import { normalizeContext, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { toDevinTranscript } from "../src/pi/adapters/pi/transcript.ts";
import { model, runSync } from "./helpers.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (id: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({ role: "assistant", api: "devin-connect", provider: "devin", model: model.id,
  content: [{ type: "toolCall", id, name: "fixture_add", arguments: { a: 1, b: 2 } }], stopReason, usage, timestamp: 1 });
const transcript = (messages: Message[], supportsImages = true) => runSync(toDevinTranscript(normalizeContext({ messages }), { ...model, supportsImages }));

test("a failed response that reuses a call ID leaves the earlier successful result in the history", () => {
  const { messages } = transcript([
    { role: "user", content: "first", timestamp: 1 }, assistant("call_0", "toolUse"),
    { role: "toolResult", toolCallId: "call_0", toolName: "fixture_add", content: [{ type: "text", text: "earlier result" }], isError: false, timestamp: 1 },
    { role: "user", content: "next", timestamp: 1 }, assistant("call_0", "error"),
    { role: "toolResult", toolCallId: "call_0", toolName: "fixture_add", content: [{ type: "text", text: "result of the failed call" }], isError: true, timestamp: 1 },
    { role: "user", content: "again", timestamp: 1 },
  ]);
  expect(messages.map((message) => message.prompt)).toStrictEqual(["first", "", "earlier result", "next", "again"]);
});

test("a text-only model gets a note for earlier user and tool images instead of failing the request", () => {
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "look: " }, { type: "image", data: PNG, mimeType: "image/png" }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: 1 },
    assistant("call_0", "toolUse"),
    { role: "toolResult", toolCallId: "call_0", toolName: "fixture_add", content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: false, timestamp: 1 },
    { role: "user", content: "text only", timestamp: 1 },
  ];
  const textOnly = transcript(history, false).messages;
  expect(textOnly.map((message) => message.prompt)).toStrictEqual(["look: (image omitted: model does not support images)", "",
    "(tool image omitted: model does not support images)", "text only"]);
  expect(textOnly.some((message) => message.images)).toBe(false);
  expect(transcript(history).messages[0].images?.length).toBe(2);
});
