import { randomUUID } from "node:crypto";
import { Effect, Predicate } from "effect";
import { toDevinError, type DevinFailure } from "../core/errors.ts";
import { safeError } from "../core/redaction.ts";
import type { ChatMessage, ChatTool, JsonObject, ToolCall } from "../core/types.ts";
import { failWith, object } from "../core/validation.ts";

export interface RegisteredTool {
  definition: ChatTool;
  canRunConcurrently?: boolean;
  execute(argumentsObject: JsonObject): Effect.Effect<string, DevinFailure>;
}

export const addTool: RegisteredTool = {
  definition: {
    name: "add", description: "Add two finite numbers and return their sum.",
    jsonSchemaString: JSON.stringify({ type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false }),
  },
  canRunConcurrently: true,
  execute: (args) => {
    if (Object.keys(args).some((key) => key !== "a" && key !== "b") || !Predicate.isNumber(args.a) || !Predicate.isNumber(args.b) || !Number.isFinite(args.a) || !Number.isFinite(args.b)) {
      return failWith("add accepts only finite numbers a and b.");
    }
    const result = args.a + args.b;
    return Number.isFinite(result) ? Effect.succeed(String(result)) : failWith("The sum is not a finite number.");
  },
};

/**
 * Runs registered tools only. A failing tool becomes an error result for the model; cancellation is not a tool result.
 * Unknown tools or duplicate call IDs stop the batch before anything runs.
 */
export function executeTools(calls: readonly ToolCall[], tools: readonly RegisteredTool[], options: {
  allowParallel?: boolean; secrets?: readonly string[];
  onTool?: (call: ToolCall, result: ChatMessage) => Effect.Effect<void>;
} = {}): Effect.Effect<ChatMessage[], DevinFailure> {
  return Effect.gen(function* () {
    const registry = new Map(tools.map((tool) => [tool.definition.name, tool]));
    if (registry.size !== tools.length) return yield* failWith("Duplicate tool name.");
    if (new Set(calls.map((call) => call.id)).size !== calls.length) return yield* failWith("Duplicate tool call ID.");
    // If any tool in the batch is unregistered, stop before running the batch.
    for (const call of calls) if (!registry.has(call.name)) return yield* failWith("Arbitrary unregistered tools are not executed.");
    const execute = (call: ToolCall) => Effect.gen(function* () {
      const outcome = yield* Effect.result(Effect.gen(function* () {
        const args = yield* Effect.try({ try: () => JSON.parse(call.argumentsJson) as unknown, catch: toDevinError }).pipe(
          Effect.flatMap((value) => object(value, "tool arguments")),
        );
        const prompt: unknown = yield* registry.get(call.name)!.execute(args);
        if (!Predicate.isString(prompt)) return yield* failWith("A tool result must be a string.");
        if (Buffer.byteLength(prompt) > 1024 * 1024) return yield* failWith("The tool result exceeds 1 MiB.");
        return prompt;
      }));
      const isError = outcome._tag === "Failure";
      const result: ChatMessage = {
        messageId: randomUUID(), source: "CHAT_MESSAGE_SOURCE_TOOL", toolCallId: call.id,
        prompt: outcome._tag === "Success" ? outcome.success : safeError(outcome.failure, options.secrets),
        ...(isError ? { toolResultIsError: true } : {}),
      };
      if (options.onTool) yield* options.onTool(call, result);
      return result;
    });
    const isParallel = options.allowParallel === true && calls.every((call) => registry.get(call.name)!.canRunConcurrently);
    return yield* Effect.forEach(calls, execute, { concurrency: isParallel ? "unbounded" : 1 });
  });
}
