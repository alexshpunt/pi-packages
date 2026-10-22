import { randomUUID } from "node:crypto";
import { Effect, Predicate } from "effect";
import { DevinError } from "../errors.ts";
import type { ChatMessage, ChatResult, JsonObject, ToolCall, Usage } from "../types.ts";
import { failWith, object, requiredString, tokenCount } from "../validation.ts";

// Backends mark a finished turn differently: Anthropic text ends with MIN_LOG_PROB, Gemini tool calls with STOP_PATTERN,
// and OpenAI sends no stop reason (UNSPECIFIED is the proto3 default, so it is not on the wire).
const COMPLETE_STOP_REASONS = new Set(["STOP_REASON_STOP_PATTERN", "STOP_REASON_FUNCTION_CALL", "STOP_REASON_MIN_LOG_PROB", "STOP_REASON_UNSPECIFIED", ""]);
const COPIED_STRINGS = [
  ["deltaSignatureType", "signatureType"], ["geminiThoughtSignature", "geminiThoughtSignature"],
  ["outputId", "outputId"], ["thinkingId", "thinkingId"], ["phase", "phase"],
] as const;
const USAGE_FIELDS = [["inputTokens", "input"], ["outputTokens", "output"], ["cacheReadTokens", "cacheRead"], ["cacheWriteTokens", "cacheWrite"]] as const;

/** Attaches argument deltas without an ID to the call that started with the first ID. Ambiguous parallel deltas are rejected. */
export class ChatAccumulator {
  readonly message: ChatMessage = { messageId: "", source: "CHAT_MESSAGE_SOURCE_SYSTEM", prompt: "" };
  readonly usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  readonly calls = new Map<string, ToolCall>();
  private currentCall?: ToolCall;
  private hasEnded = false;
  private readonly startedAt = performance.now();
  private firstDeltaMs?: number;
  private stopReason = "";
  private usageReported = false;
  private frameCount = 0;
  private stopFrameIndex?: number;
  private lastUsageFrameIndex?: number;
  private idlessToolDeltaCount = 0;
  private actualModelUid?: string;
  private usageModelUid?: string;

  accept(data: JsonObject, isEnd = false): Effect.Effect<void, DevinError> {
    const self = this;
    return Effect.gen(function* () {
      if (self.hasEnded) return yield* failWith("Cannot accumulate a response after EndStream.");
      self.frameCount++;
      if (isEnd) {
        if (data.error) return yield* failWith("An error EndStream cannot be treated as success.");
        self.hasEnded = true;
        return;
      }
      if (data.redact === true) return yield* failWith("The server redacted the response.");
      const message = self.message;
      if (Predicate.isString(data.messageId) && data.messageId) message.messageId = data.messageId;
      if (data.thinkingRedacted === true) {
        message.thinkingRedacted = true;
        message.thinking = "";
      }
      if (Predicate.isString(data.deltaText)) message.prompt += data.deltaText;
      if (Predicate.isString(data.deltaThinking) && !message.thinkingRedacted) message.thinking = (message.thinking ?? "") + data.deltaThinking;
      if (Predicate.isString(data.deltaSignature)) message.signature = (message.signature ?? "") + data.deltaSignature;
      for (const [source, target] of COPIED_STRINGS) {
        const value = data[source];
        if (Predicate.isString(value)) message[target] = value;
      }
      if (Predicate.isString(data.actualModelUid)) self.actualModelUid = data.actualModelUid;
      if (data.deltaToolCalls !== undefined) yield* self.acceptToolDeltas(data.deltaToolCalls);
      if (data.deltaText || data.deltaThinking || data.deltaToolCalls) self.firstDeltaMs ??= performance.now() - self.startedAt;
      if (Predicate.isString(data.stopReason) && data.stopReason) {
        self.stopReason = data.stopReason;
        self.stopFrameIndex = self.frameCount;
      }
      if (data.usage !== undefined) {
        const usage = yield* object(data.usage, "usage");
        if (Predicate.isString(usage.modelUid)) self.usageModelUid = usage.modelUid;
        for (const [source, target] of USAGE_FIELDS) {
          if (usage[source] === undefined) continue;
          self.usage[target] = yield* tokenCount(usage[source], source);
          self.usageReported = true;
          self.lastUsageFrameIndex = self.frameCount;
        }
        self.usage.totalTokens = self.usage.input + self.usage.output + self.usage.cacheRead + self.usage.cacheWrite;
      }
    });
  }

  private acceptToolDeltas(deltas: unknown): Effect.Effect<void, DevinError> {
    const self = this;
    return Effect.gen(function* () {
      if (!Array.isArray(deltas)) return yield* failWith("deltaToolCalls must be an array.");
      for (const value of deltas) {
        const delta = yield* object(value, "tool delta");
        const id = Predicate.isString(delta.id) && delta.id ? delta.id : undefined;
        if (id) {
          let call = self.calls.get(id);
          if (!call) {
            call = { id, name: "", argumentsJson: "" };
            self.calls.set(id, call);
          }
          self.currentCall = call;
        } else {
          self.idlessToolDeltaCount++;
          if (deltas.length !== 1 || !self.currentCall || self.calls.size > 1) {
            return yield* failWith("Cannot attach a delta without a tool ID to a specific call.");
          }
        }
        const call = self.currentCall!;
        if (delta.isCustomToolCall) return yield* failWith("Grammar-based custom tools are not supported.");
        if (delta.invalidJsonErr || delta.invalidJsonStr) return yield* failWith("The server reported a tool argument JSON error.");
        if (Predicate.isString(delta.name)) call.name += delta.name;
        if (Predicate.isString(delta.argumentsJson)) call.argumentsJson += delta.argumentsJson;
      }
    });
  }

  get finish(): Effect.Effect<ChatResult, DevinError> {
    const self = this;
    return Effect.gen(function* () {
      if (!self.hasEnded) return yield* failWith("No successful EndStream.");
      if (!COMPLETE_STOP_REASONS.has(self.stopReason) && self.stopReason !== "STOP_REASON_MAX_TOKENS") {
        return yield* failWith(`stopReason cannot be treated as success: ${self.stopReason || "(none)"}`);
      }
      if (self.calls.size > 0) {
        self.message.toolCalls = [...self.calls.values()];
        for (const call of self.message.toolCalls) {
          yield* requiredString(call.name, "tool name");
          const args = yield* Effect.try({
            try: () => JSON.parse(call.argumentsJson) as unknown,
            catch: () => new DevinError({ message: `Arguments of tool ${call.name} are not valid JSON.` }),
          });
          yield* object(args, "tool arguments");
        }
      }
      if (self.stopReason === "STOP_REASON_FUNCTION_CALL" && !self.calls.size) {
        return yield* failWith("The response ended with FUNCTION_CALL but has no tool call.");
      }
      // Tool use is read from the calls themselves; only calls cut off at the output limit are rejected.
      if (self.calls.size && !COMPLETE_STOP_REASONS.has(self.stopReason)) {
        return yield* failWith("Tool calls and the stop reason do not match.");
      }
      self.message.messageId ||= randomUUID();
      return {
        message: self.message,
        stopReason: self.stopReason,
        usage: self.usage,
        usageReported: self.usageReported,
        frameCount: self.frameCount,
        stopFrameIndex: self.stopFrameIndex,
        lastUsageFrameIndex: self.lastUsageFrameIndex,
        idlessToolDeltaCount: self.idlessToolDeltaCount,
        durationMs: Math.round(performance.now() - self.startedAt),
        firstDeltaMs: self.firstDeltaMs === undefined ? undefined : Math.round(self.firstDeltaMs),
        actualModelUid: self.actualModelUid,
        ...(self.usageModelUid ? { usageModelUid: self.usageModelUid } : {}),
      };
    });
  }
}
