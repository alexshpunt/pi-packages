import { createAssistantMessageEventStream, type AssistantMessage, type Model, type ToolCall } from "@earendil-works/pi-ai";
import type { ChatAccumulator } from "../core/inference/chat.ts";
import type { ChatMessage, ChatResult, JsonObject } from "../core/types.ts";
import { attachReplayMetadata } from "./messages.ts";
import { DEVIN_API } from "./models.ts";

export class DevinResponseStream {
  readonly stream = createAssistantMessageEventStream();
  readonly message: AssistantMessage;
  private active?: { type: "text" | "thinking"; index: number };
  private tools = new Map<string, { index: number; characters: number; hasEnded: boolean }>();
  private hasTerminated = false;
  private usageModelUid?: string;
  private hasUsageReported = false;
  constructor(model: Model<typeof DEVIN_API>, requestedUID: string) {
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
  accept(data: JsonObject, accumulator: ChatAccumulator): void {
    if (this.hasTerminated) throw new Error("Cannot add a delta to a finished Pi response.");
    if (accumulator.message.thinkingRedacted) {
      for (const block of this.message.content) if (block.type === "thinking") { block.thinking = ""; block.redacted = true; }
      if (!this.message.content.some((block) => block.type === "thinking")) this.text("thinking", "", true);
    } else if (typeof data.deltaThinking === "string" && data.deltaThinking) this.text("thinking", data.deltaThinking);
    if (typeof data.deltaText === "string" && data.deltaText) this.text("text", data.deltaText);
    for (const call of accumulator.calls.values()) {
      let state = this.tools.get(call.id);
      if (!state) {
        this.closeText();
        const index = this.message.content.length;
        this.message.content.push({ type: "toolCall", id: call.id, name: "", arguments: {} });
        state = { index, characters: 0, hasEnded: false }; this.tools.set(call.id, state);
        this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.message });
      }
      const block = this.message.content[state.index] as ToolCall;
      block.name = call.name;
      try { const value = JSON.parse(call.argumentsJson); if (value && typeof value === "object" && !Array.isArray(value)) block.arguments = value; } catch {}
      const delta = call.argumentsJson.slice(state.characters);
      state.characters = call.argumentsJson.length;
      if (delta) this.stream.push({ type: "toolcall_delta", contentIndex: state.index, delta, partial: this.message });
    }
    if (accumulator.message.messageId) this.message.responseId = accumulator.message.messageId;
    if (typeof data.actualModelUid === "string") this.message.responseModel = data.actualModelUid;
    if (data.usage && typeof data.usage === "object") {
      const usage = data.usage as JsonObject;
      if (typeof usage.modelUid === "string") this.usageModelUid = usage.modelUid;
      if (["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].some((key) => usage[key] !== undefined)) this.hasUsageReported = true;
    }
    this.message.usage = { ...accumulator.usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
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
  redact(): void {
    for (const block of this.message.content) {
      if (block.type === "text") block.text = "";
      else if (block.type === "thinking") { block.thinking = ""; block.redacted = true; }
      else block.arguments = {};
    }
    this.closeContent(); this.message.content = []; this.tools.clear();
  }
  finish(result: ChatResult): void {
    if (this.hasTerminated) return;
    if (!this.message.content.length && (result.message.signature || result.message.geminiThoughtSignature || result.message.outputId)) this.text("text", "");
    this.provenance(result.message, result.usageReported);
    this.closeContent();
    this.hasTerminated = true;
    this.message.rawStopReason = result.stopReason;
    this.message.stopReason = result.message.toolCalls?.length ? "toolUse" : result.stopReason === "STOP_REASON_MAX_TOKENS" ? "length" : "stop";
    this.stream.push({ type: "done", reason: this.message.stopReason, message: this.message });
    this.stream.end(this.message);
  }
  fail(errorMessage: string, isAborted: boolean, native?: ChatMessage): void {
    if (this.hasTerminated) return;
    if (native) this.provenance(native, this.hasUsageReported);
    this.closeContent();
    this.hasTerminated = true;
    this.message.stopReason = isAborted ? "aborted" : "error";
    this.message.errorMessage = errorMessage;
    this.stream.push({ type: "error", reason: this.message.stopReason, error: this.message });
    this.stream.end(this.message);
  }
}
