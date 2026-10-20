import { randomUUID } from "node:crypto";
import { object, requiredString, tokenCount, type ChatMessage, type ChatResult, type ChatTool, type ImageData, type JsonObject, type ToolCall, type Usage } from "../types.ts";
import type { ConnectClient } from "../protocol/transport.ts";
import { CHAT_METHOD } from "../protocol/protobuf.ts";
import { wireMessages } from "./messages.ts";

export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant. Follow the user\'s request concisely.";

export function userMessage(prompt: string, images: readonly ImageData[] = []): ChatMessage {
  return {
    messageId: randomUUID(), source: "CHAT_MESSAGE_SOURCE_USER", prompt,
    ...(images.length ? { images: images.map((image) => ({ ...image })) } : {}),
  };
}

export function chatRequest(options: {
  metadata: JsonObject;
  model: string;
  messages: ChatMessage[];
  systemPrompt: string;
  maxTokens: number;
  cascadeId: string;
  trajectoryId: string;
  executionId?: string;
  clientSessionId?: string;
  modelAssignmentJwt?: string;
  stepIndex?: number;
  isAuxiliary?: boolean;
  isRecovery?: boolean;
  includeContext?: boolean;
  cwd?: string;
  tools?: ChatTool[];
}): JsonObject {
  return {
    metadata: options.metadata,
    prompt: options.systemPrompt,
    chatMessagePrompts: wireMessages(options.messages, { includeContext: options.includeContext, cwd: options.cwd }),
    chatModelUid: options.model,
    requestType: "CHAT_MESSAGE_REQUEST_TYPE_CASCADE",
    configuration: {
      maxTokens: options.maxTokens,
      numCompletions: 1,
      maxNewlines: 400,
      temperature: 1,
      topK: 40,
      topP: Math.fround(0.95),
    },
    trajectoryReference: {
      trajectoryId: options.trajectoryId,
      trajectoryType: "CORTEX_TRAJECTORY_TYPE_CASCADE",
      ...(!options.isAuxiliary && !options.isRecovery && options.messages.at(-1)?.source === "CHAT_MESSAGE_SOURCE_USER" ? { stepType: "CORTEX_STEP_TYPE_USER_INPUT" } : {}),
      ...(options.stepIndex ? { stepIndex: options.stepIndex } : {}),
    },
    cascadeId: options.cascadeId,
    plannerMode: "CONVERSATIONAL_PLANNER_MODE_DEFAULT",
    ...(!options.isAuxiliary && options.executionId ? { executionId: options.executionId } : {}),
    ...(options.clientSessionId ? { clientSessionId: options.clientSessionId } : {}),
    ...(options.modelAssignmentJwt ? { modelAssignmentJwt: options.modelAssignmentJwt } : {}),
    ...(options.tools?.length ? { tools: options.tools } : {}),
  };
}

// Backends mark a finished turn differently: Anthropic text ends with MIN_LOG_PROB, Gemini tool calls with STOP_PATTERN,
// and OpenAI sends no stop reason (UNSPECIFIED is the proto3 default, so it is not on the wire).
const COMPLETE_STOP_REASONS = new Set(["STOP_REASON_STOP_PATTERN", "STOP_REASON_FUNCTION_CALL", "STOP_REASON_MIN_LOG_PROB", "STOP_REASON_UNSPECIFIED", ""]);

/** Attaches argument deltas without an ID to the call that started with the first ID. Ambiguous parallel deltas are rejected. */
export class ChatAccumulator {
  readonly message: ChatMessage = { messageId: "", source: "CHAT_MESSAGE_SOURCE_SYSTEM", prompt: "" };
  readonly usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  readonly calls = new Map<string, ToolCall>();
  private currentCall?: ToolCall;
  private hasEnded = false;
  private startedAt = performance.now();
  private firstDeltaMs?: number;
  private stopReason = "";
  private usageReported = false;
  private frameCount = 0;
  private stopFrameIndex?: number;
  private lastUsageFrameIndex?: number;
  private idlessToolDeltaCount = 0;
  private actualModelUid?: string;
  private usageModelUid?: string;

  accept(data: JsonObject, isEnd = false): void {
    if (this.hasEnded) throw new Error("Cannot accumulate a response after EndStream.");
    this.frameCount++;
    if (isEnd) {
      if (data.error) throw new Error("An error EndStream cannot be treated as success.");
      this.hasEnded = true;
      return;
    }
    if (data.redact === true) throw new Error("The server redacted the response.");
    if (typeof data.messageId === "string" && data.messageId) this.message.messageId = data.messageId;
    if (data.thinkingRedacted === true) {
      this.message.thinkingRedacted = true;
      this.message.thinking = "";
    }
    if (typeof data.deltaText === "string") this.message.prompt += data.deltaText;
    if (typeof data.deltaThinking === "string" && !this.message.thinkingRedacted) {
      this.message.thinking = (this.message.thinking ?? "") + data.deltaThinking;
    }
    if (typeof data.deltaSignature === "string") this.message.signature = (this.message.signature ?? "") + data.deltaSignature;
    for (const [source, target] of [
      ["deltaSignatureType", "signatureType"], ["geminiThoughtSignature", "geminiThoughtSignature"],
      ["outputId", "outputId"], ["thinkingId", "thinkingId"], ["phase", "phase"],
    ] as const) {
      if (typeof data[source] === "string") this.message[target] = data[source];
    }
    if (typeof data.actualModelUid === "string") this.actualModelUid = data.actualModelUid;
    if (data.deltaToolCalls !== undefined) {
      if (!Array.isArray(data.deltaToolCalls)) throw new Error("deltaToolCalls must be an array.");
      for (const value of data.deltaToolCalls) {
        const delta = object(value, "tool delta");
        const id = typeof delta.id === "string" && delta.id ? delta.id : undefined;
        if (id) {
          let call = this.calls.get(id);
          if (!call) {
            call = { id, name: "", argumentsJson: "" };
            this.calls.set(id, call);
          }
          this.currentCall = call;
        } else {
          this.idlessToolDeltaCount++;
          if (data.deltaToolCalls.length !== 1 || !this.currentCall || this.calls.size > 1) {
            throw new Error("Cannot attach a delta without a tool ID to a specific call.");
          }
        }
        const call = this.currentCall!;
        if (delta.isCustomToolCall) throw new Error("Grammar-based custom tools are not supported.");
        if (delta.invalidJsonErr || delta.invalidJsonStr) throw new Error("The server reported a tool argument JSON error.");
        if (typeof delta.name === "string") call.name += delta.name;
        if (typeof delta.argumentsJson === "string") call.argumentsJson += delta.argumentsJson;
      }
    }
    if (data.deltaText || data.deltaThinking || data.deltaToolCalls) {
      this.firstDeltaMs ??= performance.now() - this.startedAt;
    }
    if (typeof data.stopReason === "string" && data.stopReason) {
      this.stopReason = data.stopReason;
      this.stopFrameIndex = this.frameCount;
    }
    if (data.usage !== undefined) {
      const usage = object(data.usage, "usage");
      if (typeof usage.modelUid === "string") this.usageModelUid = usage.modelUid;
      for (const [source, target] of [
        ["inputTokens", "input"], ["outputTokens", "output"],
        ["cacheReadTokens", "cacheRead"], ["cacheWriteTokens", "cacheWrite"],
      ] as const) {
        if (usage[source] !== undefined) {
          this.usage[target] = tokenCount(usage[source], source);
          this.usageReported = true;
          this.lastUsageFrameIndex = this.frameCount;
        }
      }
      this.usage.totalTokens = this.usage.input + this.usage.output + this.usage.cacheRead + this.usage.cacheWrite;
    }
  }

  finish(): ChatResult {
    if (!this.hasEnded) throw new Error("No successful EndStream.");
    if (!COMPLETE_STOP_REASONS.has(this.stopReason) && this.stopReason !== "STOP_REASON_MAX_TOKENS") {
      throw new Error(`stopReason cannot be treated as success: ${this.stopReason || "(none)"}`);
    }
    if (this.calls.size > 0) {
      this.message.toolCalls = [...this.calls.values()];
      for (const call of this.message.toolCalls) {
        requiredString(call.name, "tool name");
        let args: unknown;
        try { args = JSON.parse(call.argumentsJson); }
        catch { throw new Error(`Arguments of tool ${call.name} are not valid JSON.`); }
        object(args, "tool arguments");
      }
    }
    if (this.stopReason === "STOP_REASON_FUNCTION_CALL" && !this.calls.size) {
      throw new Error("The response ended with FUNCTION_CALL but has no tool call.");
    }
    // Tool use is read from the calls themselves; only calls cut off at the output limit are rejected.
    if (this.calls.size && !COMPLETE_STOP_REASONS.has(this.stopReason)) {
      throw new Error("Tool calls and the stop reason do not match.");
    }
    this.message.messageId ||= randomUUID();
    return {
      message: this.message,
      stopReason: this.stopReason,
      usage: this.usage,
      usageReported: this.usageReported,
      frameCount: this.frameCount,
      stopFrameIndex: this.stopFrameIndex,
      lastUsageFrameIndex: this.lastUsageFrameIndex,
      idlessToolDeltaCount: this.idlessToolDeltaCount,
      durationMs: Math.round(performance.now() - this.startedAt),
      firstDeltaMs: this.firstDeltaMs === undefined ? undefined : Math.round(this.firstDeltaMs),
      actualModelUid: this.actualModelUid,
      ...(this.usageModelUid ? { usageModelUid: this.usageModelUid } : {}),
    };
  }
}

export async function streamChat(
  client: ConnectClient,
  request: JsonObject,
  options: { signal?: AbortSignal; onText?: (delta: string) => void; stage?: string; onDispatched?: () => void } = {},
): Promise<ChatResult> {
  const accumulator = new ChatAccumulator();
  for await (const frame of client.stream(CHAT_METHOD, request, options.signal, { stage: options.stage, onDispatched: options.onDispatched })) {
    accumulator.accept(frame.data, frame.isEnd);
    if (!frame.isEnd && typeof frame.data.deltaText === "string") options.onText?.(frame.data.deltaText);
  }
  const result = accumulator.finish();
  // Field 22 records the model of the generation request, not actualModelUid/usage.modelUid.
  if (typeof request.chatModelUid === "string") result.message.modelUid = request.chatModelUid;
  return result;
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
