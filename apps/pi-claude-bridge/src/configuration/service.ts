import { Context as ServiceContext, Layer } from "effect";
import type { LongContextSettings } from "../features/models/types.js";
import type { Config, ProviderConfigurationServices } from "./types.js";
import { fromSync } from "../adapters/effects.js";
import { markStartupNoticeShown } from "../adapters/storage/configuration.js";
import { getBridgeModels } from "../features/models/policy.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export function createProviderConfiguration(): ProviderConfigurationServices {
	// MODELS is buildModels(getModels("anthropic")) — projection kept in features/models/policy.ts.
	const MODELS = getBridgeModels();

	let providerSettings: NonNullable<Config["provider"]> = {};

	let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };

	// --- Query state ---
	// QueryContext lives in features/query/state.ts so tests can import it without
	// activating the extension.

	// Global (not query state):
	let piUI: ExtensionUIContext | null = null;

	let piMode: ExtensionContext["mode"] | null = null;

	let listPiToolMeta: ProviderConfigurationServices["listPiToolMeta"] = null;

	// Plan defaults that silently limit the user (no Opus 4.6 1M on Max) are announced
	// once, when plan detection cannot tell the plan (plan-detection.ts). Deferred to a bridge query rather
	// than session_start: the notice persists a flag to the global config, and
	// firing it on startup would write that file for every pi session that merely
	// has this extension installed. One message, because consecutive info notifies
	// overwrite each other in the TUI.
	let pendingNotices: string[] = [];

	function showStartupNoticeOnce(): void {
		// `hasUI` is true in RPC mode too — it means dialogs are possible, not that a
		// human is watching. Only a terminal user can act on this.
		if (pendingNotices.length === 0 || piMode !== "tui") return;
		const notices = pendingNotices;
		pendingNotices = [];
		const path = markStartupNoticeShown();
		// pi wraps the whole notify string in the theme's dim foreground; the inner reset
		// drops back to the terminal default rather than dim, which is fine here.
		const title = `\x1b[33mWelcome to pi-claude-bridge\x1b[39m — settings live in ${path}`;
		const bullets = [...notices, "This message only appears once. See README.md for more."].map((n) => `• ${n}`);
		piUI?.notify([title, ...bullets, "─".repeat(64)].join("\n"), "info");
	}

	return {
		MODELS,
		get longContextSettings() { return longContextSettings; },
		set longContextSettings(value: typeof longContextSettings) { longContextSettings = value; },
		get pendingNotices() { return pendingNotices; },
		set pendingNotices(value: typeof pendingNotices) { pendingNotices = value; },
		get piMode() { return piMode; },
		set piMode(value: typeof piMode) { piMode = value; },
		get piUI() { return piUI; },
		set piUI(value: typeof piUI) { piUI = value; },
		get listPiToolMeta() { return listPiToolMeta; },
		set listPiToolMeta(value: typeof listPiToolMeta) { listPiToolMeta = value; },
		get providerSettings() { return providerSettings; },
		set providerSettings(value: typeof providerSettings) { providerSettings = value; },
		showStartupNoticeOnce: () => fromSync(showStartupNoticeOnce),
	};
}

export class Configuration extends ServiceContext.Service<Configuration, ProviderConfigurationServices>()("claude-bridge/Configuration") {}
export const ConfigurationLive = Layer.sync(Configuration, createProviderConfiguration);
