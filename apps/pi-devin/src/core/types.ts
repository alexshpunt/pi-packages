export type JsonObject = Record<string, unknown>;

export function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: a JSON object is required.`);
  }
  return value as JsonObject;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}: a non-empty string is required.`);
  }
  return value;
}

export function tokenCount(value: unknown, label: string): number {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) {
    throw new Error(`${label}: invalid token count.`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${label}: invalid token count.`);
  return count;
}

export interface Credential {
  version: 1;
  sessionToken: string;
  apiServerURL: string;
  /** For compatibility with older saved files. Not used to build request fingerprints. */
  fingerprint?: string;
  createdAt: string;
}

export interface ChatTool {
  name: string;
  description: string;
  jsonSchemaString: string;
}

export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ImageData {
  base64Data: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  caption?: string;
}

export interface ChatMessage {
  messageId: string;
  source: "CHAT_MESSAGE_SOURCE_USER" | "CHAT_MESSAGE_SOURCE_SYSTEM" | "CHAT_MESSAGE_SOURCE_TOOL";
  prompt: string;
  images?: ImageData[];
  modelUid?: string;
  promptCacheOptions?: { type: "CACHE_CONTROL_TYPE_EPHEMERAL" };
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolResultIsError?: boolean;
  thinking?: string;
  signature?: string;
  signatureType?: string;
  thinkingRedacted?: boolean;
  geminiThoughtSignature?: string;
  outputId?: string;
  thinkingId?: string;
  phase?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface ChatResult {
  message: ChatMessage;
  stopReason: string;
  usage: Usage;
  usageReported: boolean;
  frameCount: number;
  stopFrameIndex?: number;
  lastUsageFrameIndex?: number;
  idlessToolDeltaCount: number;
  durationMs: number;
  firstDeltaMs?: number;
  actualModelUid?: string;
  usageModelUid?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsImages: boolean;
  supportsToolCalls: boolean;
  isRouter: boolean;
  isDisabled: boolean;
  familyId?: string;
  aliases?: string[];
  isDefaultInFamily?: boolean;
  supportsParallelToolCalls?: boolean;
  /** Variant that the catalog marks as Recommended. */
  isRecommended?: boolean;
  costTier?: string;
  creditMultiplier?: number;
  pricingType?: string;
}
