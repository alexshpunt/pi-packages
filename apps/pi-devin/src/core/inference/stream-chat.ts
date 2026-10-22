import { Effect, Predicate, Stream } from "effect";
import type { DevinFailure } from "../errors.ts";
import type { ConnectClient } from "../protocol/connect-client.ts";
import { CHAT_METHOD } from "../protocol/protobuf.ts";
import type { ChatResult, JsonObject } from "../types.ts";
import { ChatAccumulator } from "./accumulator.ts";

export interface StreamChatOptions {
  onText?: (delta: string) => Effect.Effect<void>;
  stage?: string;
  onDispatched?: Effect.Effect<void, DevinFailure>;
}

/** Sends one chat request and folds its frames into a single result. */
export function streamChat(client: ConnectClient, request: JsonObject, options: StreamChatOptions = {}): Effect.Effect<ChatResult, DevinFailure> {
  return Effect.gen(function* () {
    const accumulator = new ChatAccumulator();
    yield* client.stream(CHAT_METHOD, request, { stage: options.stage, onDispatched: options.onDispatched }).pipe(Stream.runForEach((frame) => Effect.gen(function* () {
      yield* accumulator.accept(frame.data, frame.isEnd);
      if (!frame.isEnd && Predicate.isString(frame.data.deltaText) && options.onText) yield* options.onText(frame.data.deltaText);
    })));
    const result = yield* accumulator.finish;
    // Field 22 records the model of the generation request, not actualModelUid/usage.modelUid.
    if (Predicate.isString(request.chatModelUid)) result.message.modelUid = request.chatModelUid;
    return result;
  });
}

/** Raw thinking and signatures never go to logs or reports. They are only resent inside requests. */
export function summarizeChat(result: ChatResult): JsonObject {
  return {
    text: result.message.prompt,
    stopReason: result.stopReason,
    usage: result.usage,
    usageReported: result.usageReported,
    toolCalls: result.message.toolCalls ?? [],
    thinkingChars: result.message.thinking?.length ?? 0,
    hasSignature: Boolean(result.message.signature || result.message.geminiThoughtSignature),
    frameCount: result.frameCount,
    stopFrameIndex: result.stopFrameIndex,
    lastUsageFrameIndex: result.lastUsageFrameIndex,
    idlessToolDeltaCount: result.idlessToolDeltaCount,
    durationMs: result.durationMs,
    firstDeltaMs: result.firstDeltaMs,
    actualModelUid: result.actualModelUid,
  };
}
