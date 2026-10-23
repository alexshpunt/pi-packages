import type { ProviderConfigurationServices } from "../../configuration/types.js";
import type { LoggingServices } from "../../diagnostics/types.js";
import type { ProviderPromptsServices } from "../prompt/types.js";
import type { Context } from "@earendil-works/pi-ai";
import type { Effect } from "effect";

export type AttachmentAnchor =
	| { userOrdinal: number; parentText: string }
	| { toolUseId: string };

export type CarriedAttachment = AttachmentAnchor & {
	attachment: { type: string; [key: string]: unknown };
};

export interface SessionLink {
	schemaVersion: 1;
	ccSessionId: string;
	cwd: string;
}

export interface SessionLinkWriter {
	piSessionId: string;
	cwd: string;
	getSessionId: () => string;
	getBranch: () => readonly unknown[];
	append: (data: SessionLink) => void;
}

/** What convertPiMessages discarded, for the debug line in index.ts. */
export type DroppedContent = {
	thinking: number;
	abortedTurns: number;
	providers: Set<string>;
	other: Map<string, number>;
};

export interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// The pi session this CC conversation serves, from the provider call's
	// options.sessionId. Attribution for history rewrites: a subagent's
	// session_compact must not force a rebuild of a conversation that belongs
	// to a different pi session. Null until a provider call recorded it.
	piSessionId?: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY where we have just killed a CC subprocess: an abort, or a query
	// discarded because pi rewrote the history under it. The killed subprocess
	// may still be flushing a late "[Request interrupted by user]" record to the
	// session JSONL. Reusing the same sessionId/path would race that orphan write
	// into our fresh file and break CC's parent-uuid chain on the next resume.
	// When set, REBUILD takes a fresh UUID and leaves the old files untouched.
	// With no in-flight writer, an in-place rebuild replaces the JSONL while
	// retaining the tool-results directory referenced by carried content.
	forceRotate?: boolean;
}

export interface MirrorStoreServices {
	sharedSessions: ReadonlyMap<string, Readonly<SessionState>>;
	historyRewrittenBySession: ReadonlySet<string>;
	sessionStateFor: (sessionId: string | null | undefined) => Readonly<SessionState> | null;
	setSessionStateFor: (sessionId: string | null | undefined, state: SessionState | null) => void;
	markRebuildForSession: (sessionId: string | null, event: string) => void;
	advanceCursor(sessionId: string | null | undefined, cursor: number): void;
	consumeRewrite(sessionId: string | null): void;
	clearHistoryRewrites(): void;
	clear(): void;
}

export type CarriedSessionData = {
	attachments: CarriedAttachment[];
	toolResults: Map<string, CarriedToolResult>;
	projectDir: string;
};

export interface SyncResult {
	sessionId: string | null;
	preserveSharedSession?: boolean;
}

export interface SessionSyncServices {
	readonly syncSharedSession: (messages: Context["messages"], cwd: string, customToolNameToSdk?: Map<string, string>, modelId?: string, piSessionId?: string | null, isReentrant?: boolean) => Effect.Effect<SyncResult, unknown>;
}

export type CarriedToolResultSource =
	| { kind: "image"; content: unknown[]; paths: string[] }
	| { kind: "saved"; path: string; isJSON: boolean };

export interface CarriedToolResult {
	content: unknown;
	isError: boolean;
	source: CarriedToolResultSource;
}

export interface MirrorStoreDependencies {
	diagnostics: LoggingServices;
}

export interface SessionSyncDependencies {
	diagnostics: LoggingServices;
	configuration: ProviderConfigurationServices;
	sessions: MirrorStoreServices;
	prompts: ProviderPromptsServices;
}
