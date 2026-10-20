import { randomUUID } from "node:crypto";
import { chatRequest, streamChat, summarizeChat, userMessage, DEFAULT_SYSTEM_PROMPT } from "../core/inference/chat.ts";
import { DevinClient } from "../core/client.ts";
import { createSession } from "./session-store.ts";
import { object, type ChatResult, type ChatTool, type ImageData, type JsonObject, type ModelInfo } from "../core/types.ts";

export const ADD_TOOL: ChatTool = {
  name: "add",
  description: "Add exactly two numbers. Returns their sum.",
  jsonSchemaString: JSON.stringify({
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
    additionalProperties: false,
  }),
};

function requireComplete(result: ChatResult): void {
  if (!result.usageReported) throw new Error("A response arrived, but the final token usage could not be confirmed.");
  if (result.stopReason === "STOP_REASON_MAX_TOKENS") throw new Error("The output limit was reached. Full response verification failed.");
}

export interface RunObserver {
  beforeCall?: (stage: string) => void;
  onResult?: (stage: string, result: JsonObject) => void;
  onText?: (delta: string) => void;
}

export async function textTurn(client: DevinClient, options: {
  model: string; prompt: string; maxTokens: number; signal?: AbortSignal; images?: readonly ImageData[];
} & RunObserver): Promise<ChatResult> {
  options.beforeCall?.("text");
  const session = createSession(options.model);
  const result = await streamChat(client.transport, chatRequest({
    metadata: client.metadata(), model: options.model,
    messages: [userMessage(options.prompt, options.images)],
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    maxTokens: options.maxTokens, cascadeId: session.cascadeId,
    trajectoryId: session.trajectoryId, clientSessionId: session.id, executionId: randomUUID(),
  }), options);
  options.onResult?.("text", summarizeChat(result));
  requireComplete(result);
  if (result.stopReason !== "STOP_REASON_STOP_PATTERN" || !result.message.prompt.trim()) {
    throw new Error("Could not confirm a plain text response.");
  }
  return result;
}

export async function toolRoundtrip(client: DevinClient, options: {
  model: string; maxTokens: number; signal?: AbortSignal;
} & RunObserver): Promise<{ first: ChatResult; second: ChatResult; toolResult: number }> {
  const session = createSession(options.model);
  const cascadeId = session.cascadeId;
  const user = userMessage("What is 17 + 25? Call the add tool exactly once with a=17 and b=25, then report its result.");
  const common = {
    model: options.model, maxTokens: options.maxTokens, cascadeId,
    trajectoryId: session.trajectoryId, clientSessionId: session.id, executionId: randomUUID(),
    systemPrompt: "Use the provided add tool for the calculation. After receiving its result, reply with only the result number. Do not call the tool again.",
    tools: [ADD_TOOL],
  };
  options.beforeCall?.("tool-call");
  const first = await streamChat(client.transport, chatRequest({ ...common, metadata: client.metadata(), messages: [user] }), options);
  options.onResult?.("tool-call", summarizeChat(first));
  requireComplete(first);
  const calls = first.message.toolCalls;
  if (first.stopReason !== "STOP_REASON_FUNCTION_CALL" || calls?.length !== 1 || calls[0].name !== "add") {
    throw new Error("The add tool must be called exactly once. Arbitrary tools are not executed.");
  }
  const args = object(JSON.parse(calls[0].argumentsJson), "add arguments");
  if (Object.keys(args).length !== 2 || args.a !== 17 || args.b !== 25) {
    throw new Error("The add tool call returned arguments other than the requested input (17, 25).");
  }
  const toolResult = args.a + args.b;
  options.beforeCall?.("tool-result");
  const second = await streamChat(client.transport, chatRequest({
    ...common,
    metadata: client.metadata(),
    stepIndex: 1,
    // Tool call IDs, thinking and signatures are preserved. Wire message IDs are assigned anew on serialization.
    messages: [user, first.message, {
      messageId: randomUUID(), source: "CHAT_MESSAGE_SOURCE_TOOL",
      toolCallId: calls[0].id, prompt: String(toolResult), toolResultIsError: false,
    }],
  }), options);
  options.onResult?.("tool-result", summarizeChat(second));
  requireComplete(second);
  if (second.stopReason !== "STOP_REASON_STOP_PATTERN" || second.message.toolCalls?.length) {
    throw new Error("The response after the tool result did not end as a plain answer.");
  }
  if (!/\b42\b/.test(second.message.prompt)) throw new Error("Could not find the tool result 42 in the final answer.");
  return { first, second, toolResult };
}

export function selectModel(models: ModelInfo[], id: string, needsTools = false): ModelInfo {
  const model = models.find((entry) => entry.id === id);
  if (!model) throw new Error(`${id} is not in the model list. It is not replaced with another model automatically.`);
  if (model.isRouter || model.isDisabled) throw new Error("Routers and disabled models are not called.");
  if (needsTools && !model.supportsToolCalls) throw new Error("The selected model does not support tool calls.");
  return model;
}
