// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/claude-bridge.json)
// and the project Pi config directory, project overriding global. Missing files,
// unparseable JSON and non-object roots are ignored (error to console.error,
// empty object returned) so the extension always starts.

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";

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

function readConfigObject(path: string): Partial<Config> {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Config root must be a JSON object");
	}
	return parsed as Partial<Config>;
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return readConfigObject(path);
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-bridge.json");
}

/** Merge extension-written fields into the global config, preserving every other field.
 *  Returns the config path for display either way.
 *
 *  Parses directly rather than through tryParseJson, which reports an unparseable file as `{}`:
 *  spreading that would replace a user's whole config with just these fields the first time they
 *  leave a trailing comma in it. Losing the marker is the cheaper failure, so the write is
 *  skipped and the extension simply writes again next session. `fields` receives the existing
 *  config and returns null when nothing needs writing. */
function updateGlobalConfig(fields: (existing: Partial<Config>) => Partial<Config> | null): string {
	const path = globalConfigPath();
	let existing: Partial<Config> = {};
	if (existsSync(path)) {
		try {
			existing = readConfigObject(path);
		} catch (e) {
			console.error(`claude-bridge: leaving ${path} alone, it does not parse: ${e}`);
			return path;
		}
	}
	const update = fields(existing);
	if (update === null) return path;
	mkdirSync(dirname(path), { recursive: true });
	// Pi processes starting together (sub-agents) read this file while one of them writes it;
	// a partly written file parses as {} there and drops the user's settings for that session.
	// Write a sibling and rename it into place, at the real path so a symlinked config stays a link.
	const target = existsSync(path) ? realpathSync(path) : path;
	const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o666;
		writeFileSync(temporary, `${JSON.stringify({ ...existing, ...update }, null, 2)}\n`, { mode });
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
	return path;
}

/** Record today's date in the global config so the startup notice shows once. */
export function markStartupNoticeShown(): string {
	// en-CA renders YYYY-MM-DD in local time; toISOString() would report UTC.
	return updateGlobalConfig(() => ({ startupNoticeShown: new Date().toLocaleDateString("en-CA") }));
}

/** Map Claude Code's account subscription label ("Claude Max" from CC 2.1.303) to a plan tier,
 *  or undefined when the label cannot decide it. Team plans stay undecided: only Team Premium
 *  includes Max-tier long context, and the label does not tell the two apart. */
export function planFromSubscriptionType(subscriptionType: string | undefined): ClaudePlan | undefined {
	const words = subscriptionType?.toLowerCase().split(/[^a-z]+/) ?? [];
	if (words.includes("team")) return undefined;
	if (words.includes("max") || words.includes("enterprise")) return "max";
	if (words.includes("pro")) return "pro";
	return undefined;
}

/** The plan an earlier detection recorded, when the global config holds a valid one. */
export function readDetectedPlan(): ClaudePlan | undefined {
	const plan = tryParseJson(globalConfigPath()).detectedPlan;
	return plan === "pro" || plan === "max" ? plan : undefined;
}

/** Record the detected plan in the global config, skipping an unchanged value. */
export function recordDetectedPlan(plan: ClaudePlan): void {
	updateGlobalConfig((existing) => (existing.detectedPlan === plan ? null : { detectedPlan: plan }));
}

/** Detect an obsolete enabled tool only for its process-local removal notice. */
export function hasRemovedToolEnabled(cwd: string): boolean {
	const enabled = (config: Config): unknown =>
		(config as Config & { askClaude?: { enabled?: unknown } }).askClaude?.enabled;
	const project = enabled(tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json")));
	return (project === undefined ? enabled(tryParseJson(globalConfigPath())) : project) === true;
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(globalConfigPath());
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	return {
		startupNoticeShown: project.startupNoticeShown ?? global.startupNoticeShown,
		provider: { ...global.provider, ...project.provider },
	};
}
