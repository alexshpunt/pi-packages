import { randomUUID } from "node:crypto";
import { getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { imageFromBase64, MAX_IMAGES_BYTES } from "../core/inference/images.ts";
import { object, requiredString, type ChatMessage, type ChatTool, type ModelInfo } from "../core/types.ts";
import { DEVIN_API } from "./models.ts";

const REPLAY_PREFIX = "devin:v1:";
const replayStrings = ["signature", "signatureType", "geminiThoughtSignature", "outputId", "thinkingId", "phase", "modelUid"] as const;
type ReplayMetadata = Pick<ChatMessage, typeof replayStrings[number] | "thinkingRedacted">;

export function encodeReplayMetadata(message: ChatMessage): string {
  const metadata: ReplayMetadata = {};
  for (const key of replayStrings) if (message[key] !== undefined) metadata[key] = message[key];
  if (message.thinkingRedacted !== undefined) metadata.thinkingRedacted = message.thinkingRedacted;
  return REPLAY_PREFIX + JSON.stringify(metadata);
}
function replayMetadata(value: string | undefined): ReplayMetadata | undefined {
  if (!value?.startsWith(REPLAY_PREFIX)) return undefined;
  let parsed: Record<string, unknown>;
  try { parsed = object(JSON.parse(value.slice(REPLAY_PREFIX.length)), "Devin replay metadata"); }
  catch { throw new Error("Invalid Devin response replay metadata."); }
  const result: ReplayMetadata = {};
  for (const key of replayStrings) {
    if (parsed[key] !== undefined && typeof parsed[key] !== "string") throw new Error("Unexpected Devin response replay metadata format.");
    if (typeof parsed[key] === "string") result[key] = parsed[key];
  }
  if (parsed.thinkingRedacted !== undefined) {
    if (typeof parsed.thinkingRedacted !== "boolean") throw new Error("Invalid Devin redacted thinking metadata.");
    result.thinkingRedacted = parsed.thinkingRedacted;
  }
  return result;
}

export function attachReplayMetadata(output: AssistantMessage, message: ChatMessage): void {
  const signature = encodeReplayMetadata(message);
  for (const block of output.content) {
    if (block.type === "thinking") block.thinkingSignature = signature;
    else if (block.type === "text") block.textSignature = signature;
    else block.thoughtSignature = signature;
  }
}

export function toDevinTranscript(context: TranscriptContext, model: ModelInfo): { messages: ChatMessage[]; tools: ChatTool[]; systemPrompt: string } {
  const declarations = getCurrentTools(context.messages);
  if (declarations.length && !model.supportsToolCalls) throw new Error("This model does not support the current Pi tool declarations.");
  const tools = declarations.map((tool) => {
    if (tool.constrainedSampling && (tool.constrainedSampling.type === "grammar" || tool.constrainedSampling.strict === "require")) {
      throw new Error(`Devin does not support this tool's forced sampling format: ${tool.name}`);
    }
    return { name: tool.name, description: tool.description, jsonSchemaString: JSON.stringify(tool.parameters) };
  });
  const failedCalls = new Set(context.messages.flatMap((message) => message.role === "assistant" && ["error", "aborted"].includes(message.stopReason)
    ? message.content.filter((block) => block.type === "toolCall").map((block) => block.id) : []));
  const messages: ChatMessage[] = [];
  for (const message of context.messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      if (message.stopReason === "pending") throw new Error("An unfinished assistant response cannot be sent as Devin history.");
      const own = message.provider === "devin" && message.api === DEVIN_API;
      const result: ChatMessage = { messageId: message.responseId ?? randomUUID(), source: "CHAT_MESSAGE_SOURCE_SYSTEM", prompt: "" };
      let replay: ReplayMetadata | undefined;
      for (const block of message.content) {
        if (block.type === "text") result.prompt += block.text;
        else if (block.type === "thinking") {
          if (!block.redacted) result.thinking = (result.thinking ?? "") + block.thinking;
          else result.thinkingRedacted = true;
        } else {
          result.toolCalls ??= [];
          result.toolCalls.push({ id: requiredString(block.id, "tool call id"), name: block.namespace ? `${block.namespace}.${block.name}` : block.name,
            argumentsJson: JSON.stringify(object(block.arguments, "tool arguments")) });
        }
        if (own) {
          const metadata = replayMetadata(block.type === "text" ? block.textSignature : block.type === "thinking" ? block.thinkingSignature : block.thoughtSignature);
          if (metadata) {
            if (replay && JSON.stringify(replay) !== JSON.stringify(metadata)) throw new Error("Devin replay metadata differs within one response.");
            replay = metadata;
          }
        }
      }
      Object.assign(result, replay);
      if (own && message.providerThinkingLevel) result.modelUid = message.providerThinkingLevel;
      if (result.thinkingRedacted) result.thinking = "";
      messages.push(result);
      continue;
    }
    if (message.role === "toolResult" && failedCalls.has(message.toolCallId)) continue;
    const result: ChatMessage = {
      messageId: randomUUID(), source: message.role === "toolResult" ? "CHAT_MESSAGE_SOURCE_TOOL" : "CHAT_MESSAGE_SOURCE_USER", prompt: "",
      ...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolResultIsError: message.isError } : {}),
    };
    let imageBytes = 0;
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const block of content) {
      if (block.type === "text") result.prompt += block.text;
      else {
        if (!model.supportsImages) throw new Error("This model does not support images in history or tool results.");
        const converted = imageFromBase64(block.data, block.mimeType);
        imageBytes += converted.sizeBytes;
        if (imageBytes > MAX_IMAGES_BYTES) throw new Error(`Images in one message must total at most ${MAX_IMAGES_BYTES} bytes.`);
        (result.images ??= []).push(converted.image);
      }
    }
    messages.push(result);
  }
  return { messages, tools, systemPrompt: getCurrentSystemPrompt(context.messages) };
}
