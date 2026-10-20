import type { CarriedAttachment } from "../attachments.js";
import { collectCarriedAttachments } from "../attachments.js";
import { placeCarriedAttachments } from "../attachments.js";
import { convertPiMessages, matchLiveToolResultKeyOrder } from "../convert.js";
import { debugLogPath } from "../log-paths.js";
import { verifyWrittenSession as _verifyWrittenSession } from "../session-verify.js";
import { nonSystemMessages } from "../transcript.js";
import type { Context } from "@earendil-works/pi-ai";
import { createSession, openSession, repairToolPairing } from "cc-session-io";
import { lstatSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BridgeRuntime } from "../runtime.js";
import { applyCarriedToolResults, collectCarriedToolResults, type CarriedToolResult } from "./tool-result-carry.js";
import { lookupSessionLink } from "./continuity.js";

type CarriedSessionData = {
	attachments: CarriedAttachment[];
	toolResults: Map<string, CarriedToolResult>;
	projectDir: string;
};

/** Clear the current mirror, not its valid saved-result directory. Never follow
 *  a companion or tool-results symlink while clearing other auxiliary state. */
export function deleteSessionKeepingToolResults(jsonlPath: string): void {
	if (!jsonlPath.endsWith(".jsonl")) throw new Error("Expected a Claude Code JSONL session path");
	rmSync(jsonlPath, { force: true });
	const companion = jsonlPath.slice(0, -".jsonl".length);
	const stat = lstatSync(companion, { throwIfNoEntry: false });
	if (!stat) return;
	if (!stat.isDirectory()) { rmSync(companion, { force: true }); return; }
	for (const entry of readdirSync(companion, { withFileTypes: true })) {
		if (entry.name === "tool-results" && entry.isDirectory()) continue;
		rmSync(join(companion, entry.name), { recursive: true, force: true });
	}
}

export interface SyncResult {
	sessionId: string | null;
	preserveSharedSession?: boolean;
}

export interface SessionSyncServices {
	readonly syncSharedSession: (messages: Context["messages"], cwd: string, customToolNameToSdk?: Map<string, string>, modelId?: string, piSessionId?: string | null, isReentrant?: boolean) => SyncResult;
}

export function createSessionSync(runtime: Pick<BridgeRuntime, "DEBUG" | "debug" | "diagDump" | "piUI" | "sessionStateFor" | "setSessionStateFor" | "turnStart">): SessionSyncServices {
	/** Read records before replacing the JSONL. Saved outputs are checked lazily
	 *  only for tool ids still present in the history being imported. */
	function readCarriedSession(sessionId: string, cwd: string): CarriedSessionData | undefined {
		let previous: ReturnType<typeof openSession>;
		try {
			previous = openSession({ sessionId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
		} catch (error) {
			// A killed writer may have left a partial last line. Failure to carry must
			// not prevent rebuilding from Pi's authoritative history.
			runtime.debug(`WARNING: could not read attachments from session ${sessionId.slice(0, 8)}:`, error);
			return undefined;
		}
		let attachments: CarriedAttachment[] = [];
		let toolResults = new Map<string, CarriedToolResult>();
		try { attachments = collectCarriedAttachments(previous.records); }
		catch (error) { runtime.debug(`WARNING: could not read attachments from session ${sessionId.slice(0, 8)}:`, error); }
		try { toolResults = collectCarriedToolResults(previous.records); }
		catch (error) { runtime.debug(`WARNING: could not read tool results from session ${sessionId.slice(0, 8)}:`, error); }
		return { attachments, toolResults, projectDir: dirname(previous.jsonlPath) };
	}

	// Convert pi messages to Anthropic API format for session import.
	// Lossy: only text, thinking and toolCall blocks survive, and thinking only when
	// Claude Code itself minted the signature. An assistant message whose blocks all
	// filter out keeps its slot with a placeholder, since dropping it can create a
	// tool_result with no preceding tool_use. A turn aborted before anything streamed
	// is dropped instead — it never had content, and inventing one diverges from the
	// prefix Claude Code cached.
	function convertAndImportMessages(
		session: ReturnType<typeof createSession>,
		messages: Context["messages"],
		customToolNameToSdk?: Map<string, string>,
		carried?: CarriedSessionData,
	): void {
		const { anthropicMessages, sanitizedIds, dropped } = convertPiMessages(messages, customToolNameToSdk);

		runtime.debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
		runtime.debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
			const c = m.content;
			if (typeof c === "string") return `[${i}]${m.role}:text`;
			if (Array.isArray(c)) return `[${i}]${m.role}:${(c).map((b) => b.type).join("+")}`;
			return `[${i}]${m.role}:?`;
		}).join(" "));
		// The roles line above shows only what survived, so a stripped block is
		// indistinguishable there from one that never existed. Name the losses.
		const droppedParts = [
			dropped.thinking ? `${dropped.thinking} thinking (${[...dropped.providers].sort().join(", ")})` : "",
			dropped.abortedTurns ? `${dropped.abortedTurns} aborted turn(s)` : "",
			...[...dropped.other].map(([type, n]) => `${n} ${type}`),
		].filter(Boolean);
		if (droppedParts.length > 0) {
			runtime.debug(`convertAndImportMessages: dropped ${droppedParts.join(", ")}`);
		}
		if (sanitizedIds.size > 0) {
			runtime.debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
				[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
		}
		// Pre-repair for debug logging; importMessages also repairs internally (idempotent).
		const repaired = repairToolPairing(anthropicMessages);
		if (repaired.length !== anthropicMessages.length) {
			runtime.debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
		}
		// Placement runs against the repaired array because that is the index space
		// importMessages reads. Attachments are links in CC's uuid chain, so they have
		// to be written in order with the messages, not appended afterwards.
		const placed = carried?.attachments.length
			? placeCarriedAttachments(carried.attachments, repaired as unknown as { role: string; content: unknown }[])
			: undefined;
		if (placed?.skipped.length) {
			runtime.debug(`convertAndImportMessages: dropped ${placed.skipped.length} carried attachment(s): ${placed.skipped.join("; ")}`);
		}
		if (placed?.attachments.length) {
			runtime.debug(`convertAndImportMessages: carrying ${placed.attachments.length} attachment(s) across the rebuild`);
		}
		if (carried?.toolResults.size) {
			const replaced = applyCarriedToolResults(repaired as unknown as { role: string; content: unknown }[], carried.toolResults, carried.projectDir);
			if (replaced.length) runtime.debug(`convertAndImportMessages: carrying Claude Code's content for ${replaced.length} tool result(s): ${replaced.join(", ")}`);
		}
		if (repaired.length) {
			session.importMessages(repaired, placed?.attachments.length ? { attachments: placed.attachments } : undefined);
			matchLiveToolResultKeyOrder(session.records);
		}
	}

	/**
	 * Ensure the shared session has all messages up to (but not including) the last user message.
	 * Returns session ID to resume from, or null if no resume needed.
	 */
	// Read the session file we just wrote and sanity-check it. Warns instead of
	// throwing — CC may be more tolerant than our checks, so a false positive
	// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
	// fans each warning out to debug log + piUI notify + diagDump.
	function verifyWrittenSession(
		jsonlPath: string,
		expectedSessionId: string,
		expectedRecordCount: number,
		cwd: string,
	): void {
		const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
		for (const msg of warnings) {
			runtime.debug(`WARNING session verify: ${msg}`);
			runtime.piUI?.notify(
				`Session file issue: ${msg}\n` +
				`cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
				`Please copy and paste this message into a new issue at https://github.com/buYoung/pi-packages/issues/new` +
				(runtime.DEBUG ? ` and attach ${debugLogPath()}` : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
				"warning",
			);
			runtime.diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null });
		}
	}

	function safeRealpath(p: string): string {
		try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
	}

	// Diagnostic snapshot of where a session file was just written. Catches the
	// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
	// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
	function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
		const realCwd = safeRealpath(cwd);
		let fileSize: number | null = null;
		let fileExists = false;
		try {
			const st = statSync(jsonlPath);
			fileExists = true;
			fileSize = st.size;
		} catch { /* file may not exist yet */ }
		runtime.debug(`${label}: cwd=${cwd}`);
		if (realCwd !== cwd) runtime.debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
		runtime.debug(`${label}: jsonlPath=${jsonlPath}`);
		runtime.debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
		runtime.debug(`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
	}

	// Two semantic paths:
	//   REUSE — pi's history is in sync with the existing sharedSession (or drifted
	//     only by the trailing final-assistant message that pi appends after
	//     streamSimple returns, which CC's own persisted session already has).
	//     Returns the existing sessionId. Keeps CC's prompt cache warm.
	//   REBUILD — no session yet, or pi's history has diverged (non-trailing
	//     missed messages, e.g. another provider took a turn). Wipes the existing
	//     session file (if any) and writes a fresh one containing all prior
	//     messages, reusing the same sessionId across rebuilds so UUIDs stay
	//     stable for the lifetime of pi's session.
	//
	// Why a full rebuild rather than patching:
	//   Injecting deltas into an existing session creates a branch that CC's
	//   --resume doesn't follow (documented attempt prior to this). A complete
	//   overwrite at the same path is simpler and correct.
	//
	// Why reuse the sessionId across rebuilds:
	//   CC re-reads the JSONL on every --resume call — no in-process UUID
	//   caching. Validated in tests/exp-session-clear.mjs, including the case
	//   where CC had appended its own tool_use/tool_result records between
	//   rebuilds. Preserving the UUID means stable log correlation across
	//   provider switches and no orphaned session files.
	//
	// Log strings still say "Case 1/2/3/4" so existing diagnostics (int-cache.sh,
	// int-session-resume.mjs) keep grepping the same anchors.
		function syncSharedSession(
		messages: Context["messages"],
		cwd: string,
		customToolNameToSdk?: Map<string, string>,
		modelId?: string,
		piSessionId?: string | null,
		isReentrant = false,
	): SyncResult {
		// System messages are pi's transcript representation of prompt and tool state, not
		// conversation history — they are never imported into a CC session, so exclude them from
		// the history space (priorMessages, cursor, missed) everywhere below (issue #106).
		// The mirror this sync coordinates belongs to the syncing pi session alone:
		// every read and write below addresses sessionStateFor(piSessionId), so a
		// foreign session's shape-matching context can never REUSE or rebuild another
		// session's CC file.
		const sharedSession = runtime.sessionStateFor(piSessionId);
		const history = nonSystemMessages(messages);
		const priorMessages = history.slice(0, runtime.turnStart(history)); // everything before the current user turn

		// REUSE path
		//
		// Guard on priorMessages.length >= cursor: a shorter incoming context cannot
		// be a continuation of the cached session. This is the general invariant for
		// pi-side history rewrites such as /compact and session_tree: without it,
		// missed = [].slice(cursor) can falsely hit REUSE and resume an unrelated
		// longer CC session. See issue #25.
		if (sharedSession && !sharedSession.needsRebuild && priorMessages.length >= sharedSession.cursor) {
			const missed = priorMessages.slice(sharedSession.cursor);
			const trailingAssistantOnly =
				missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
			if (missed.length === 0 || trailingAssistantOnly) {
			if (trailingAssistantOnly) {
				runtime.setSessionStateFor(piSessionId, { ...sharedSession, cursor: priorMessages.length, cwd });
				runtime.debug(`Case 3: advanced cursor past trailing assistant, resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${priorMessages.length}`);
			} else {
				runtime.debug(`Case 3: resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
			}
			runtime.debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${sharedSession?.cursor}`);
			return { sessionId: sharedSession.sessionId };
			}
		}
		// This is what keeps a caller with a pruned or short context from resuming
		// — then overwriting — the bucket's session: shorter-than-cursor means the
		// incoming history cannot be a continuation, so start clean and preserve.
		// Historically this also caught reentrant subagents (a subagent's priors are
		// shorter than the parent's cursor); with per-session mirrors it now catches
		// reentrant queries on a session's own bucket and calls without a session id.
		// The captured ephemeral session is
		// deleted once its query completes (see preserveSharedSession in the
		// completion handler).
		//
		// It is NOT, despite an earlier comment here, the isolated compact-summary
		// path: runIsolatedSummary never calls syncSharedSession at all.
		//
		// Only reachable when needsRebuild is false — user-facing history rewrites
		// (/compact, session_tree, /new, fork) always set needsRebuild or clear
		// sharedSession before the next syncSharedSession call.
		//
		// A pi session's own non-reentrant query is neither of those: its shorter
		// history was rewritten by an extension that fires no event pi exposes
		// (context folding, billion-context-pi's compress), so it REBUILDs from what
		// pi sends now. Starting clean dropped the whole conversation (issue #77).
		if (sharedSession && !sharedSession.needsRebuild && priorMessages.length < sharedSession.cursor && (isReentrant || !piSessionId)) {
			runtime.debug(`Case 1 synthetic: clean start for shorter context, preserving shared session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
			runtime.debug(`syncResult: path=clean-start preserve-shared sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
			return { sessionId: null, preserveSharedSession: true };
		}

		// REBUILD path
		if (priorMessages.length === 0) {
			runtime.debug(`Case 1: clean start, ${history.length} total messages`);
			runtime.debug(`syncResult: path=clean-start`);
			return { sessionId: null };
		}
		const previousSessionId = sharedSession?.sessionId;
		const previousCursor = sharedSession?.cursor ?? 0;
		// Rebuild in place unless an abort/discard may still have a writer. Saved
		// output paths must survive even when the JSONL itself is replaced.
		const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate;
		const linkedSessionId = previousSessionId === undefined ? lookupSessionLink(piSessionId, cwd, runtime.debug) : undefined;
		const carrySource = previousSessionId ?? linkedSessionId;
		const carried = carrySource !== undefined ? readCarriedSession(carrySource, cwd) : undefined;
		if (linkedSessionId) runtime.debug(`Case 2: carrying from linked session ${linkedSessionId.slice(0, 8)} (new process, read-only)`);
		const session = createSession({
			projectPath: cwd,
			claudeDir: process.env.CLAUDE_CONFIG_DIR,
			...(preserveId ? { sessionId: previousSessionId } : {}),
			...(modelId ? { model: modelId } : {}),
		});
		if (preserveId) deleteSessionKeepingToolResults(session.jsonlPath);
		convertAndImportMessages(session, priorMessages, customToolNameToSdk, carried);
		session.save();
		// records, not messages: `messages` filters out the attachment records that
		// carrying an `@file` expansion across a rebuild writes into the same file.
		verifyWrittenSession(session.jsonlPath, session.sessionId, session.records.length, cwd);
		runtime.setSessionStateFor(piSessionId, { sessionId: session.sessionId, cursor: priorMessages.length, cwd, piSessionId: piSessionId ?? undefined });
		if (previousSessionId === undefined) {
			runtime.debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.records.length} records`);
		} else if (preserveId) {
			const missedCount = priorMessages.length - previousCursor;
			runtime.debug(`Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.records.length} records`);
		} else {
			runtime.debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.records.length} records`);
		}
		debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath);
		runtime.debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`);
		return { sessionId: session.sessionId };
	}

	return {
		syncSharedSession,
	};
}
