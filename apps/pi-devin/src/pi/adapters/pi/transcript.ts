import { randomUUID } from "node:crypto";
import { getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { Effect, Predicate } from "effect";
import { DevinError } from "../../../core/errors.ts";
import { imageFromBase64, MAX_IMAGES_BYTES } from "../../../core/inference/images.ts";
import type { ChatMessage, ChatTool, ModelInfo } from "../../../core/types.ts";
import { failWith, object, requiredString } from "../../../core/validation.ts";
import { DEVIN_API } from "../../features/catalog/constants.ts";

const REPLAY_PREFIX = "devin:v1:";
const replayStrings = ["signature", "signatureType", "geminiThoughtSignature", "outputId", "thinkingId", "phase", "modelUid"] as const;
type ReplayMetadata = Pick<ChatMessage, typeof replayStrings[number] | "thinkingRedacted">;
export interface DevinTranscript { messages: ChatMessage[]; tools: ChatTool[]; systemPrompt: string }

export function encodeReplayMetadata(message: ChatMessage): string {
  const metadata: ReplayMetadata = {};
  for (const key of replayStrings) if (message[key] !== undefined) metadata[key] = message[key];
  if (message.thinkingRedacted !== undefined) metadata.thinkingRedacted = message.thinkingRedacted;
  return REPLAY_PREFIX + JSON.stringify(metadata);
}

function replayMetadata(value: string | undefined): Effect.Effect<ReplayMetadata | undefined, DevinError> {
  if (!value?.startsWith(REPLAY_PREFIX)) return Effect.succeed(undefined);
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({ try: () => JSON.parse(value.slice(REPLAY_PREFIX.length)) as unknown, catch: () => undefined }).pipe(
      Effect.flatMap((json) => object(json, "Devin replay metadata")),
      Effect.mapError(() => new DevinError({ message: "Invalid Devin response replay metadata." })),
    );
    const result: ReplayMetadata = {};
    for (const key of replayStrings) {
      const field = parsed[key];
      if (field !== undefined && !Predicate.isString(field)) return yield* failWith("Unexpected Devin response replay metadata format.");
      if (Predicate.isString(field)) result[key] = field;
    }
    if (parsed.thinkingRedacted !== undefined) {
      if (!Predicate.isBoolean(parsed.thinkingRedacted)) return yield* failWith("Invalid Devin redacted thinking metadata.");
      result.thinkingRedacted = parsed.thinkingRedacted;
    }
    return result;
  });
}

/** Stores the native response metadata on every content block, so the next request can replay it exactly. */
export function attachReplayMetadata(output: AssistantMessage, message: ChatMessage): void {
  const signature = encodeReplayMetadata(message);
  for (const block of output.content) {
    if (block.type === "thinking") block.thinkingSignature = signature;
    else if (block.type === "text") block.textSignature = signature;
    else block.thoughtSignature = signature;
  }
}

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_DATA = new Set(["enum", "const", "default", "examples", "example"]);

/** Devin's own tools give every schema a single `type`; its Gemini route rejects a list such as `["integer", "null"]`. */
function toDevinToolSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toDevinToolSchema);
  if (!schema || typeof schema !== "object") return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_DATA.has(key)) result[key] = value;
    else if (SCHEMA_MAPS.has(key) && Predicate.isObject(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, toDevinToolSchema(child)]));
    } else if (key === "type" && Array.isArray(value)) {
      // Omitting the field still covers null; several remaining types become one branch each.
      const types = value.filter((type) => type !== "null");
      if (types.length === 1) result.type = types[0];
      else if (types.length > 1 && !("anyOf" in schema)) result.anyOf = types.map((type) => ({ type }));
      else result.type = value;
    } else result[key] = toDevinToolSchema(value);
  }
  return result;
}

function toolDeclarations(context: TranscriptContext, model: ModelInfo): Effect.Effect<ChatTool[], DevinError> {
  return Effect.gen(function* () {
    const declarations = getCurrentTools(context.messages);
    if (declarations.length && !model.supportsToolCalls) return yield* failWith("This model does not support the current Pi tool declarations.");
    const tools: ChatTool[] = [];
    for (const tool of declarations) {
      // Grammar sampling is optional; like Pi's providers without grammar tools, send the JSON schema instead.
      if (tool.constrainedSampling && tool.constrainedSampling.type === "json_schema" && tool.constrainedSampling.strict === "require") {
        return yield* failWith(`Devin does not support this tool's forced sampling format: ${tool.name}`);
      }
      tools.push({ name: tool.name, description: tool.description, jsonSchemaString: JSON.stringify(toDevinToolSchema(tool.parameters)) });
    }
    return tools;
  });
}

type ContextMessage = TranscriptContext["messages"][number];

/** A successful assistant response with its own replay metadata, never a failed or unfinished one. */
function assistantMessage(message: Extract<ContextMessage, { role: "assistant" }>): Effect.Effect<ChatMessage, DevinError> {
  return Effect.gen(function* () {
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
        result.toolCalls.push({ id: yield* requiredString(block.id, "tool call id"), name: block.namespace ? `${block.namespace}.${block.name}` : block.name,
          argumentsJson: JSON.stringify(yield* object(block.arguments, "tool arguments")) });
      }
      if (own) {
        const metadata = yield* replayMetadata(block.type === "text" ? block.textSignature : block.type === "thinking" ? block.thinkingSignature : block.thoughtSignature);
        if (metadata) {
          if (replay && JSON.stringify(replay) !== JSON.stringify(metadata)) return yield* failWith("Devin replay metadata differs within one response.");
          replay = metadata;
        }
      }
    }
    Object.assign(result, replay);
    if (own && message.providerThinkingLevel) result.modelUid = message.providerThinkingLevel;
    if (result.thinkingRedacted) result.thinking = "";
    return result;
  });
}

/** A user message or tool result with its images, within the per-message image budget. */
function inputMessage(message: Exclude<ContextMessage, { role: "assistant" | "system" }>, model: ModelInfo): Effect.Effect<ChatMessage, DevinError> {
  return Effect.gen(function* () {
    const result: ChatMessage = {
      messageId: randomUUID(), source: message.role === "toolResult" ? "CHAT_MESSAGE_SOURCE_TOOL" : "CHAT_MESSAGE_SOURCE_USER", prompt: "",
      ...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolResultIsError: message.isError } : {}),
    };
    let imageBytes = 0, isAfterPlaceholder = false;
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const block of content) {
      if (block.type === "text") {
        result.prompt += block.text; isAfterPlaceholder = false;
      } else if (!model.supportsImages) {
        // Like Pi's own providers: a text-only model gets a note instead, so earlier images do not stop the conversation.
        if (!isAfterPlaceholder) result.prompt += message.role === "toolResult" ? NON_VISION_TOOL_IMAGE_PLACEHOLDER : NON_VISION_USER_IMAGE_PLACEHOLDER;
        isAfterPlaceholder = true;
      } else {
        const converted = yield* imageFromBase64(block.data, block.mimeType);
        imageBytes += converted.sizeBytes;
        if (imageBytes > MAX_IMAGES_BYTES) return yield* failWith(`Images in one message must total at most ${MAX_IMAGES_BYTES} bytes.`);
        (result.images ??= []).push(converted.image);
      }
    }
    return result;
  });
}

/** Pi history as Devin chat messages. Failed or aborted assistants and the results of their tool calls are not replayed. */
export function toDevinTranscript(context: TranscriptContext, model: ModelInfo): Effect.Effect<DevinTranscript, DevinError> {
  return Effect.gen(function* () {
    const tools = yield* toolDeclarations(context, model);
    // Results follow their assistant, so only the calls of the latest failed assistant are skipped. A later failure that
    // reuses an earlier call ID leaves the earlier result in place.
    let failedCalls = new Set<string>();
    const messages: ChatMessage[] = [];
    for (const message of context.messages) {
      if (message.role === "system") continue;
      if (message.role === "assistant") {
        const isFailed = message.stopReason === "error" || message.stopReason === "aborted";
        failedCalls = new Set(isFailed ? message.content.filter((block) => block.type === "toolCall").map((block) => block.id) : []);
        if (isFailed) continue;
        if (message.stopReason === "pending") return yield* failWith("An unfinished assistant response cannot be sent as Devin history.");
        messages.push(yield* assistantMessage(message));
        continue;
      }
      if (message.role === "toolResult" && failedCalls.has(message.toolCallId)) continue;
      messages.push(yield* inputMessage(message, model));
    }
    return { messages, tools, systemPrompt: getCurrentSystemPrompt(context.messages) };
  });
}
