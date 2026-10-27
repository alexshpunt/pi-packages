import type { getBridgeModels } from "../features/models/policy.js";
import type { LongContextSettings } from "../features/models/types.js";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Effect } from "effect";

export type ClaudePlan = "pro" | "max";

export interface Config {
	/** Date (YYYY-MM-DD) the one-time startup notice was shown. Written by the extension, not the user. */
	startupNoticeShown?: string;
	/** Plan detected from the Claude Code login. Written by the extension, not the user;
	 *  provider.plan overrides it. Read from the global config only. */
	detectedPlan?: ClaudePlan;
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		autoMemoryEnabled?: boolean;
		pathToClaudeCodeExecutable?: string;
		// Subscription plan tier. Setting to "max" enables Opus 4.6 at 1M context.
		// When unset, the plan detected from the Claude Code login applies.
		plan?: ClaudePlan;
		// Set to true to opt into metered 1M context usage ("extra usage" in
		// Anthropic billing). Enables Sonnet 4.6 [1m] on every plan and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
		// Model ids (e.g. "claude-future-9") whose declared 1M context Claude Code
		// does not actually serve; pins them to the bare id at 200K.
		forceTwoHundredK?: string[];
	};
}

export interface ProviderConfigurationServices {
	readonly MODELS: ReturnType<typeof getBridgeModels>;
	longContextSettings: LongContextSettings;
	pendingNotices: string[];
	piMode: ExtensionContext["mode"] | null;
	piUI: ExtensionUIContext | null;
	/** The `_meta` pi's extensions report for each tool, by tool name, in the session this
	 *  instance registered in (adapters/pi/tool-meta.ts). */
	listPiToolMeta: (() => ReadonlyMap<string, Record<string, unknown>>) | null;
	providerSettings: NonNullable<Config["provider"]>;
	readonly showStartupNoticeOnce: () => Effect.Effect<void, unknown>;
}
