import type { Model } from "@earendil-works/pi-ai";
import type { RequestOptionsInput } from "./types.js";
import type { EffortLevel, Options, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";

// --- Effort level mapping ---
// Pi reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

// Prefer the model's own thinkingLevelMap (per-model overrides — e.g. a map can
// route xhigh→xhigh where the generic table maps xhigh→max). pi-ai's catalog
// ships a map for most Claude models; the table above covers models without
// one, and the levels a map leaves unnamed. A null entry means the level is
// unsupported on that model: no effort argument is sent, so Claude Code's own
// default applies rather than the generic table's value. Map values are
// provider-generic strings, so a map value is trusted only when it names a
// level CC accepts.
export function effortForReasoning(model: Model<any>, reasoning: string | undefined): EffortLevel | undefined {
	if (!reasoning) return undefined;
	const mapping: Readonly<Record<string, string | null | undefined>> | undefined = model.thinkingLevelMap;
	const mapped = mapping?.[reasoning];
	if (mapped === undefined) return REASONING_TO_EFFORT[reasoning];
	return VALID_EFFORTS.has(mapped as EffortLevel) ? mapped as EffortLevel : undefined;
}

// Catalog Claude families use adaptive thinking from generation 4.6 onward.
// Keep older generations on their existing CC defaults rather than copying
// CC's model denylist or sending an unverified adaptive option to them.
function canUseAdaptiveThinking(model: Model<any>): boolean {
	const version = /^claude-[a-z]+-(\d+)(?:-(\d+))?(?:-|$)/.exec(model.id);
	if (!version) return false;
	const major = Number(version[1]);
	return major > 4 || (major === 4 && Number(version[2] ?? 0) >= 6);
}

// Explicit reasoning must not depend on CC's user settings. Pi represents off
// by omission; preserve the catalog exception for models that cannot turn off.
export function thinkingForReasoning(model: Model<any>, reasoning: string | undefined): ThinkingConfig | undefined {
	if (!model.reasoning) return undefined;
	if (reasoning && reasoning !== "off") {
		return canUseAdaptiveThinking(model) ? { type: "adaptive", display: "summarized" } : undefined;
	}
	return model.thinkingLevelMap?.off === null ? undefined : { type: "disabled" };
}

export function buildProviderRequestOptions(input: RequestOptionsInput): Partial<Options> {
	const effort = effortForReasoning(input.model, input.reasoning);
	const thinking = thinkingForReasoning(input.model, input.reasoning);
	return {
		systemPrompt: { type: "preset", preset: "claude_code", snapshot: false, append: input.systemPrompt ? input.systemPrompt : undefined },
		model: input.cliModel,
		...(effort && !thinking ? { extraArgs: { "thinking-display": "summarized" } } : {}),
		...(effort ? { effort } : {}),
		...(thinking ? { thinking } : {}),
	};
}

export function buildSummaryRequestOptions(input: RequestOptionsInput): Partial<Options> {
	const effort = effortForReasoning(input.model, input.reasoning);
	const thinking = thinkingForReasoning(input.model, input.reasoning);
	return {
		systemPrompt: input.systemPrompt,
		model: input.cliModel,
		...(effort ? { effort } : {}),
		...(thinking ? { thinking } : {}),
	};
}
