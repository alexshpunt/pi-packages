import { createAssistantMessageEventStream, type AssistantMessage, type Model, type ToolCall } from "@earendil-works/pi-ai";
import { Effect, Predicate } from "effect";
import type { DevinError } from "../../../core/errors.ts";
import type { ChatAccumulator } from "../../../core/inference/accumulator.ts";
import type { ChatMessage, ChatResult, JsonObject } from "../../../core/types.ts";
import { failWith } from "../../../core/validation.ts";
import { DEVIN_API } from "../../features/catalog/constants.ts";
import type { DevinAPI } from "../../features/catalog/types.ts";
import { attachReplayMetadata } from "./transcript.ts";

const USAGE_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

/** Pi's event stream for one Devin response: one start, balanced content events and exactly one terminal event. */
export class DevinResponseStream {
  readonly stream = createAssistantMessageEventStream();
  readonly message: AssistantMessage;
  private active?: { type: "text" | "thinking"; index: number };
  private readonly tools = new Map<string, { index: number; characters: number; hasEnded: boolean }>();
  private hasTerminated = false;
  private usageModelUid?: string;
  private hasUsageReported = false;

  constructor(model: Model<DevinAPI>, requestedUID: string) {
    this.message = {
      role: "assistant", api: DEVIN_API, provider: "devin", model: model.id, providerThinkingLevel: requestedUID,
      content: [], stopReason: "pending", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    this.stream.push({ type: "start", partial: this.message });
  }

  private closeText(): void {
    if (!this.active) return;
    const block = this.message.content[this.active.index];
    if (block.type === "text") this.stream.push({ type: "text_end", contentIndex: this.active.index, content: block.text, partial: this.message });
    else if (block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex: this.active.index, content: block.thinking, partial: this.message });
    this.active = undefined;
  }

  private text(type: "text" | "thinking", delta: string, redacted = false): void {
    if (!this.active || this.active.type !== type) {
      this.closeText();
      const index = this.message.content.length;
      this.message.content.push(type === "text" ? { type, text: "" } : { type, thinking: "", ...(redacted ? { redacted: true } : {}) });
      this.active = { type, index };
      this.stream.push({ type: type === "text" ? "text_start" : "thinking_start", contentIndex: index, partial: this.message });
    }
    const block = this.message.content[this.active.index];
    if (!delta) return;
    if (block.type === "text") {
      block.text += delta;
      this.stream.push({ type: "text_delta", contentIndex: this.active.index, delta, partial: this.message });
    } else if (block.type === "thinking") {
      block.thinking += delta;
      this.stream.push({ type: "thinking_delta", contentIndex: this.active.index, delta, partial: this.message });
    }
  }

  /** Emits the content events of one frame the accumulator already accepted. */
  accept(data: JsonObject, accumulator: ChatAccumulator): Effect.Effect<void, DevinError> {
    return Effect.suspend(() => {
      if (this.hasTerminated) return failWith("Cannot add a delta to a finished Pi response.");
      if (accumulator.message.thinkingRedacted) {
        for (const block of this.message.content) if (block.type === "thinking") { block.thinking = ""; block.redacted = true; }
        if (!this.message.content.some((block) => block.type === "thinking")) this.text("thinking", "", true);
      } else if (Predicate.isString(data.deltaThinking) && data.deltaThinking) this.text("thinking", data.deltaThinking);
      if (Predicate.isString(data.deltaText) && data.deltaText) this.text("text", data.deltaText);
      for (const call of accumulator.calls.values()) this.toolDelta(call.id, call.name, call.argumentsJson);
      if (accumulator.message.messageId) this.message.responseId = accumulator.message.messageId;
      if (Predicate.isString(data.actualModelUid)) this.message.responseModel = data.actualModelUid;
      if (Predicate.isObject(data.usage)) {
        const usage = data.usage as JsonObject;
        if (Predicate.isString(usage.modelUid)) this.usageModelUid = usage.modelUid;
        if (USAGE_FIELDS.some((key) => usage[key] !== undefined)) this.hasUsageReported = true;
      }
      this.message.usage = { ...accumulator.usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      return Effect.void;
    });
  }

  private toolDelta(id: string, name: string, argumentsJson: string): void {
    let state = this.tools.get(id);
    if (!state) {
      this.closeText();
      const index = this.message.content.length;
      this.message.content.push({ type: "toolCall", id, name: "", arguments: {} });
      state = { index, characters: 0, hasEnded: false }; this.tools.set(id, state);
      this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.message });
    }
    const block = this.message.content[state.index] as ToolCall;
    block.name = name;
    try {
      const value = JSON.parse(argumentsJson) as unknown;
      if (Predicate.isObject(value)) block.arguments = value as ToolCall["arguments"];
    } catch { /* Partial arguments stay as the last complete object until the call ends. */ }
    const delta = argumentsJson.slice(state.characters);
    state.characters = argumentsJson.length;
    if (delta) this.stream.push({ type: "toolcall_delta", contentIndex: state.index, delta, partial: this.message });
  }

  private closeContent(): void {
    this.closeText();
    for (const state of this.tools.values()) if (!state.hasEnded) {
      state.hasEnded = true;
      this.stream.push({ type: "toolcall_end", contentIndex: state.index, toolCall: this.message.content[state.index] as ToolCall, partial: this.message });
    }
  }

  private provenance(native: ChatMessage, usageReported: boolean): void {
    this.message.providerThinkingLevel = native.modelUid ?? this.message.providerThinkingLevel;
    attachReplayMetadata(this.message, native);
    this.message.diagnostics = [{ type: "devin_provenance", timestamp: Date.now(), details: {
      requestedUID: this.message.providerThinkingLevel ?? "", ...(this.message.responseModel ? { responseUID: this.message.responseModel } : {}),
      ...(this.usageModelUid ? { usageUID: this.usageModelUid } : {}), costsUnknown: true, usageReported,
    } }];
  }

  /** The server redacted the response: everything shown so far is cleared and closed. */
  get redact(): Effect.Effect<void> {
    return Effect.sync(() => {
      for (const block of this.message.content) {
        if (block.type === "text") block.text = "";
        else if (block.type === "thinking") { block.thinking = ""; block.redacted = true; }
        else block.arguments = {};
      }
      this.closeContent(); this.message.content = []; this.tools.clear();
    });
  }

  finish(result: ChatResult): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.hasTerminated) return;
      if (!this.message.content.length && (result.message.signature || result.message.geminiThoughtSignature || result.message.outputId)) this.text("text", "");
      this.provenance(result.message, result.usageReported);
      // Pi runs no call whose arguments are invalid, reports the error to the model and lets it call again.
      for (const [id, error] of Object.entries(result.toolArgumentErrors)) {
        const state = this.tools.get(id);
        if (!state) continue;
        const block = this.message.content[state.index] as ToolCall;
        block.arguments = {}; block.argumentsError = error;
      }
      this.closeContent();
      this.hasTerminated = true;
      this.message.rawStopReason = result.stopReason;
      // At the output limit Pi runs none of the calls, since their arguments may be cut off, and asks the model to repeat them.
      this.message.stopReason = result.stopReason === "STOP_REASON_MAX_TOKENS" ? "length" : result.message.toolCalls?.length ? "toolUse" : "stop";
      this.stream.push({ type: "done", reason: this.message.stopReason, message: this.message });
      this.stream.end(this.message);
    });
  }

  fail(errorMessage: string, isAborted: boolean, native?: ChatMessage): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.hasTerminated) return;
      if (native) this.provenance(native, this.hasUsageReported);
      this.closeContent();
      this.hasTerminated = true;
      this.message.stopReason = isAborted ? "aborted" : "error";
      this.message.errorMessage = errorMessage;
      this.stream.push({ type: "error", reason: this.message.stopReason, error: this.message });
      this.stream.end(this.message);
    });
  }
}
