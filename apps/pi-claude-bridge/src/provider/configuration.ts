import type { Config } from "../config.js";
import { markStartupNoticeShown } from "../config.js";
import { getBridgeModels } from "../models.js";
import type { LongContextSettings } from "../models.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";



export interface ProviderConfigurationServices {
	readonly MODELS: ReturnType<typeof getBridgeModels>;
	longContextSettings: LongContextSettings;
	pendingNotices: string[];
	piMode: ExtensionContext["mode"] | null;
	piUI: ExtensionUIContext | null;
	providerSettings: NonNullable<Config["provider"]>;
	readonly showStartupNoticeOnce: () => void;
}

export function createProviderConfiguration(): ProviderConfigurationServices {
	// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
	const MODELS = getBridgeModels();

	let providerSettings: NonNullable<Config["provider"]> = {};

	let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };

	// --- Query state ---
	// QueryContext lives in provider/query-context.js so tests can import it without
	// activating the extension.

	// Global (not query state):
	let piUI: ExtensionUIContext | null = null;

	let piMode: ExtensionContext["mode"] | null = null;

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
		get providerSettings() { return providerSettings; },
		set providerSettings(value: typeof providerSettings) { providerSettings = value; },
		showStartupNoticeOnce,
	};
}
