import { randomUUID } from "node:crypto";
import { safeError } from "../core/protocol/transport.ts";
import { object, type ChatMessage, type ChatTool, type JsonObject, type ToolCall } from "../core/types.ts";

export interface RegisteredTool {
  definition: ChatTool;
  canRunConcurrently?: boolean;
  execute(argumentsObject: JsonObject, signal?: AbortSignal): string | Promise<string>;
}

export const addTool: RegisteredTool = {
  definition: {
    name: "add", description: "Add two finite numbers and return their sum.",
    jsonSchemaString: JSON.stringify({ type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false }),
  },
  canRunConcurrently: true,
  execute(args, signal) {
    signal?.throwIfAborted();
    if (Object.keys(args).some((key) => key !== "a" && key !== "b") || typeof args.a !== "number" || typeof args.b !== "number" || !Number.isFinite(args.a) || !Number.isFinite(args.b)) {
      throw new Error("add accepts only finite numbers a and b.");
    }
    const result = args.a + args.b;
    if (!Number.isFinite(result)) throw new Error("The sum is not a finite number.");
    return String(result);
  },
};

export async function executeTools(calls: readonly ToolCall[], tools: readonly RegisteredTool[], options: {
  signal?: AbortSignal; allowParallel?: boolean; secrets?: readonly string[];
  onTool?: (call: ToolCall, result: ChatMessage) => void;
} = {}): Promise<ChatMessage[]> {
  const registry = new Map(tools.map((tool) => [tool.definition.name, tool]));
  if (registry.size !== tools.length) throw new Error("Duplicate tool name.");
  if (new Set(calls.map((call) => call.id)).size !== calls.length) throw new Error("Duplicate tool call ID.");
  // If any tool in the batch is unregistered, stop before running the batch.
  for (const call of calls) if (!registry.has(call.name)) throw new Error("Arbitrary unregistered tools are not executed.");
  const execute = async (call: ToolCall): Promise<ChatMessage> => {
    options.signal?.throwIfAborted();
    let prompt: string;
    let isError = false;
    try {
      const args = object(JSON.parse(call.argumentsJson), "tool arguments");
      prompt = await registry.get(call.name)!.execute(args, options.signal);
      if (typeof prompt !== "string") throw new Error("A tool result must be a string.");
      if (Buffer.byteLength(prompt) > 1024 * 1024) throw new Error("The tool result exceeds 1 MiB.");
    } catch (error) {
      options.signal?.throwIfAborted();
      isError = true;
      prompt = safeError(error, options.secrets);
    }
    options.signal?.throwIfAborted();
    const result: ChatMessage = {
      messageId: randomUUID(), source: "CHAT_MESSAGE_SOURCE_TOOL", prompt, toolCallId: call.id,
      ...(isError ? { toolResultIsError: true } : {}),
    };
    options.onTool?.(call, result);
    return result;
  };
  if (options.allowParallel && calls.every((call) => registry.get(call.name)!.canRunConcurrently)) return Promise.all(calls.map(execute));
  const results: ChatMessage[] = [];
  for (const call of calls) results.push(await execute(call));
  return results;
}
