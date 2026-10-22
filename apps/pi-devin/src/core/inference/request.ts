import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatTool, ImageData, JsonObject } from "../types.ts";
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
