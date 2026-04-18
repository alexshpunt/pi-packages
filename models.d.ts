// Type declarations for models.js.

import type { Model } from "@mariozechner/pi-ai";

export const MODEL_IDS_IN_ORDER: string[];

export function buildModels<T extends { id: string; [key: string]: any }>(
	piAiModels: T[],
): Array<Pick<T, "id" | "name" | "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens">>;

export function resolveModelId(models: Array<{ id: string }>, input: string): string;
