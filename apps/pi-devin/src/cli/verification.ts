import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { DevinClient } from "../core/client.ts";
import { toDevinError, type DevinError, type DevinFailure } from "../core/errors.ts";
import { chatRequest, DEFAULT_SYSTEM_PROMPT, userMessage } from "../core/inference/request.ts";
import { streamChat, summarizeChat } from "../core/inference/stream-chat.ts";
import type { ChatResult, ChatTool, ImageData, JsonObject, ModelInfo } from "../core/types.ts";
import { failWith, object } from "../core/validation.ts";
import { createSession } from "./services/sessions.ts";

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

function requireComplete(result: ChatResult): Effect.Effect<void, DevinError> {
  if (!result.usageReported) return failWith("A response arrived, but the final token usage could not be confirmed.");
  if (result.stopReason === "STOP_REASON_MAX_TOKENS") return failWith("The output limit was reached. Full response verification failed.");
  return Effect.void;
}

export interface RunObserver {
  beforeCall?: (stage: string) => Effect.Effect<void>;
  onResult?: (stage: string, result: JsonObject) => Effect.Effect<void>;
  onText?: (delta: string) => Effect.Effect<void>;
}

const observe = <A>(effect: Effect.Effect<A> | undefined) => effect ?? Effect.void;

export function textTurn(client: DevinClient, options: {
  model: string; prompt: string; maxTokens: number; images?: readonly ImageData[];
} & RunObserver): Effect.Effect<ChatResult, DevinFailure> {
  return Effect.gen(function* () {
    yield* observe(options.beforeCall?.("text"));
    const session = createSession(options.model);
    const result = yield* streamChat(client.transport, chatRequest({
      metadata: yield* client.metadata(), model: options.model,
      messages: [userMessage(options.prompt, options.images)],
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      maxTokens: options.maxTokens, cascadeId: session.cascadeId,
      trajectoryId: session.trajectoryId, clientSessionId: session.id, executionId: randomUUID(),
    }), { onText: options.onText });
    yield* observe(options.onResult?.("text", summarizeChat(result)));
    yield* requireComplete(result);
    if (result.stopReason !== "STOP_REASON_STOP_PATTERN" || !result.message.prompt.trim()) return yield* failWith("Could not confirm a plain text response.");
    return result;
  });
}

export function toolRoundtrip(client: DevinClient, options: {
  model: string; maxTokens: number;
} & RunObserver): Effect.Effect<{ first: ChatResult; second: ChatResult; toolResult: number }, DevinFailure> {
  return Effect.gen(function* () {
    const session = createSession(options.model);
    const user = userMessage("What is 17 + 25? Call the add tool exactly once with a=17 and b=25, then report its result.");
    const common = {
      model: options.model, maxTokens: options.maxTokens, cascadeId: session.cascadeId,
      trajectoryId: session.trajectoryId, clientSessionId: session.id, executionId: randomUUID(),
      systemPrompt: "Use the provided add tool for the calculation. After receiving its result, reply with only the result number. Do not call the tool again.",
      tools: [ADD_TOOL],
    };
    yield* observe(options.beforeCall?.("tool-call"));
    const first = yield* streamChat(client.transport, chatRequest({ ...common, metadata: yield* client.metadata(), messages: [user] }), { onText: options.onText });
    yield* observe(options.onResult?.("tool-call", summarizeChat(first)));
    yield* requireComplete(first);
    const calls = first.message.toolCalls;
    if (first.stopReason !== "STOP_REASON_FUNCTION_CALL" || calls?.length !== 1 || calls[0].name !== "add") {
      return yield* failWith("The add tool must be called exactly once. Arbitrary tools are not executed.");
    }
    const args = yield* Effect.try({ try: () => JSON.parse(calls[0].argumentsJson) as unknown, catch: toDevinError }).pipe(Effect.flatMap((value) => object(value, "add arguments")));
    if (Object.keys(args).length !== 2 || args.a !== 17 || args.b !== 25) {
      return yield* failWith("The add tool call returned arguments other than the requested input (17, 25).");
    }
    const toolResult = (args.a as number) + (args.b as number);
    yield* observe(options.beforeCall?.("tool-result"));
    const second = yield* streamChat(client.transport, chatRequest({
      ...common,
      metadata: yield* client.metadata(),
      stepIndex: 1,
      // Tool call IDs, thinking and signatures are preserved. Wire message IDs are assigned anew on serialization.
      messages: [user, first.message, {
        messageId: randomUUID(), source: "CHAT_MESSAGE_SOURCE_TOOL",
        toolCallId: calls[0].id, prompt: String(toolResult), toolResultIsError: false,
      }],
    }), { onText: options.onText });
    yield* observe(options.onResult?.("tool-result", summarizeChat(second)));
    yield* requireComplete(second);
    if (second.stopReason !== "STOP_REASON_STOP_PATTERN" || second.message.toolCalls?.length) {
      return yield* failWith("The response after the tool result did not end as a plain answer.");
    }
    if (!/\b42\b/.test(second.message.prompt)) return yield* failWith("Could not find the tool result 42 in the final answer.");
    return { first, second, toolResult };
  });
}

export function selectModel(models: readonly ModelInfo[], id: string, needsTools = false): Effect.Effect<ModelInfo, DevinError> {
  const model = models.find((entry) => entry.id === id);
  if (!model) return failWith(`${id} is not in the model list. It is not replaced with another model automatically.`);
  if (model.isRouter || model.isDisabled) return failWith("Routers and disabled models are not called.");
  if (needsTools && !model.supportsToolCalls) return failWith("The selected model does not support tool calls.");
  return Effect.succeed(model);
}
