// Token accounting: map Claude Code's SDK usage counters onto pi's AssistantMessage.
// Logging-free like convert.ts — it returns what it derived and index.ts logs it.
// Extracted from index.ts so tests can reach it without activating the extension.

import { calculateCost, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { SdkUsage, UsageReport } from "./types.js";

/**
 * Applies one SDK usage frame onto `output.usage`, then recomputes the token total and cost.
 *
 * Counters the frame omits keep their previous value, so the partial frames the three call
 * sites deliver never zero out what an earlier one set.
 */
export function updateUsage(output: AssistantMessage, usage: SdkUsage, model: Model<Api>): UsageReport {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	// A subset of output_tokens, never a separate addend in the total or in cost.
	const reasoning = usage.output_tokens_details?.thinking_tokens;
	if (reasoning != null) output.usage.reasoning = reasoning;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const report: UsageReport = { cachePct: promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0 };
	if (reasoning != null) report.reasoning = reasoning;
	return report;
}
