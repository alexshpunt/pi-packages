// Canonical selection + display order for the model picker.
// `resolveModel` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const MODEL_IDS_IN_ORDER = ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai are silently dropped.
//
// Display names are bare: whether a model runs in 1M context is a per-cwd config
// decision (provider.enableLongContextModels), so the static picker can't truthfully
// advertise it. See README "1M context window" for the capability/entitlement matrix.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id))
		.filter((m) => m != null)
		// Forward thinkingLevelMap so per-model overrides (e.g. opus-4-7 mapping
		// xhigh→xhigh instead of xhigh→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id,
			name,
			reasoning, input, contextWindow, maxTokens, thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

// A model is 1M-*capable* when its advertised window exceeds 200K. Capability is
// not entitlement: Sonnet 4.6's 1M is metered on every plan (including Max), while
// Opus 1M is included on Max/Team/Enterprise. Capability only gates whether opting
// in via provider.enableLongContextModels has any effect.
export function hasOneMContext(model: { contextWindow?: number | null }): boolean {
	return (model.contextWindow ?? 0) > 200_000;
}

// Append [1m] to the CLI model id only when the model is 1M-capable AND the user
// has opted in for that specific model. The [1m] suffix is what tells the Claude
// Code CLI to open its 1M window; the bare id keeps the 200K default. Unlike the
// context-1m-2025-08-07 beta (issue #24), the model-id path works under
// Pro/Max subscription (OAuth) auth, where the CLI ignores custom betas.
export function claudeCodeModelId(model: { id: string; contextWindow?: number | null }, oneMEnabled: boolean): string {
	return oneMEnabled && hasOneMContext(model) && !model.id.includes("[1m]") ? `${model.id}[1m]` : model.id;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.includes(lower));
}

// Produce the model metadata registered with pi. The registered contextWindow must
// match the window the bridge actually requests from Claude Code, or pi's status
// bar and auto-compaction threshold will misreport: registering 1M while the CLI
// runs at 200K (the bare-id default for unlisted long-context models) recreates
// the "pi shows headroom but CC errors with Prompt is too long / credit gate"
// bug (issue #24, #17). So a long-context-capable model is registered at 1M only
// when opted into longContextModelIds (the same set that drives the [1m] suffix);
// otherwise its window is capped at 200K. Haiku (200K native) is unaffected.
//
// Caveat: on Max/Team/Enterprise a bare Opus id is auto-upgraded to 1M by Claude
// Code (default since v2.1.75), so an unlisted Opus registers 200K but runs at
// 1M — pi will compact earlier than the true headroom allows. This is the safe
// direction (wasteful, not a hard failure); the bridge can't detect plan tier to
// do better. Max users wanting accurate 1M budgeting for Opus can list it in
// enableLongContextModels (sends [1m]; included per Anthropic docs, though see
// claude-code#39841 for a reported Max 5x regression).
export function applyLongContext<T extends { id: string; contextWindow?: number | null }>(
	models: T[],
	longContextModelIds: Set<string>,
): T[] {
	return models.map((m) => {
		if (longContextModelIds.has(m.id) && hasOneMContext(m)) return m;
		const capped = Math.min(m.contextWindow ?? 200_000, 200_000);
		return capped === m.contextWindow ? m : { ...m, contextWindow: capped };
	});
}
