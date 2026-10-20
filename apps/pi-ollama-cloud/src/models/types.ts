import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
export type ChatModelConfig =
  Extract<ProviderModelConfig, { type?: "chat" }> extends never
    ? ProviderModelConfig
    : Extract<ProviderModelConfig, { type?: "chat" }>;
/** Response from POST /api/show */
export interface OllamaShowResponse {
  model_info?: Record<string, unknown> | null;
  capabilities: string[];
  /** Optional metadata is validated separately so a future vocabulary can safely fall back. */
  thinking?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOllamaShowResponse(value: unknown): value is OllamaShowResponse {
  return (
    isRecord(value) &&
    (value.model_info === undefined || value.model_info === null || isRecord(value.model_info)) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === "string")
  );
}
