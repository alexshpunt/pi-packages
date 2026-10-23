import type { LoggingServices } from "../../diagnostics/types.js";
import type { sharedPromptCaptures } from "./capture.js";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { Context } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";

// What pi assembled for one agent, kept so the bridge can append only the
// portable parts after Claude Code's own preset.

export type PromptCaptureInput = {
	custom?: string;
	append?: string;
	contextFiles: { path: string; content: string }[];
	skills: Skill[];
	/** Explicit prompt and declared-tool guidance, independent of registration source. */
	promptGuidelines?: string[];
	toolSnippets?: Record<string, string>;
	toolGuidelines?: Record<string, string[]>;
	/** Custom prompt sections from `systemPromptOptions.sections`, raw content keyed by
	 *  section name. pi renders each one as `<name>\ncontent\n</name>` after the built-in
	 *  sections; the projection does the same. */
	sections?: Record<string, string>;
};

export type InheritedPrompt = {
	start: number;
	end: number;
	parent: PromptCapture;
};

export type PromptCapture = PromptCaptureInput & {
	assembledPrompt: string;
	/** Which bridge boundary last recorded this key (before_agent_start | agent_start | turn_start). */
	source?: string;
	/** Exact previously assembled prompts embedded in `custom`. */
	inherited: InheritedPrompt[];
};

/**
 * Captures keyed by the fully assembled prompt pi sends to a provider.
 *
 * A sub-agent's systemPromptOverride embeds its parent's assembled prompt
 * verbatim. Pi currently exposes that override as an ordinary custom prompt,
 * without provenance. Linking exact prior keys recovers the inheritance graph
 * without recognizing pi prose or sub-agent markers. If pi later exposes an
 * inherited-system-prompt field, it should replace this inference.
 */
export type PromptCaptureDiagnostic = {
	/** The prompt that matched nothing: the full system prompt is too big to log
	 *  inline, so a fingerprint plus the closest match's first divergent offset
	 *  are enough to recognize the pump.
	 *
	 *  Closest is by shared prefix — the case that matters here is pi itself
	 *  rebuilding the prompt outside `before_agent_start` (a changed tool list or
	 *  fresh resource discovery), which edits near the boundary, and a prefix key
	 *  gets us to within a handful of characters of where. */
	systemPrompt: string;
	matches: { key: string; firstDivergent: number; source?: string }[];
};

export type ContextFile = { path: string; content: string };

export interface ProviderPromptsServices {
	readonly extractIsolatedSummaryPrompt: (messages: Context["messages"]) => string;
	readonly extractUserPrompt: (messages: Context["messages"]) => string | null;
	readonly extractUserPromptBlocks: (messages: Context["messages"]) => ContentBlockParam[] | null;
	readonly promptCaptures: ReturnType<typeof sharedPromptCaptures>;
	readonly steerBlocks: (messages: Context["messages"]) => ContentBlockParam[] | null;
	readonly turnStart: (messages: Context["messages"]) => number;
}

export type SkillReadTool = "mcp" | "none";

export interface ProviderPromptsDependencies {
	diagnostics: LoggingServices;
}
