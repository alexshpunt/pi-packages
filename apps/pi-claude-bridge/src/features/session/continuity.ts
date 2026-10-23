import { lstatSync, realpathSync } from "node:fs";
import type { SessionLink, SessionLinkWriter } from "./types.js";
import { dirname, resolve } from "node:path";
import { getSessionPath } from "cc-session-io";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SESSION_LINK_TYPE = "claude-bridge-cc-session";
const WRITERS_KEY = Symbol.for("claude-bridge:sessionLinkWriters");
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
type Debug = (...values: unknown[]) => void;

function writers(): Map<string, SessionLinkWriter> {
	const globals = globalThis as Record<symbol, unknown>;
	return (globals[WRITERS_KEY] ??= new Map<string, SessionLinkWriter>()) as Map<string, SessionLinkWriter>;
}

function canonicalCwd(cwd: string): string {
	try { return realpathSync(cwd); }
	catch { return resolve(cwd); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The last connection on this branch is authoritative. An unsupported/corrupt
 *  last entry must not silently resurrect an older connection on the same branch. */
function lastBranchLink(writer: SessionLinkWriter): SessionLink | undefined {
	const branch = writer.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SESSION_LINK_TYPE) continue;
		const data = entry.data;
		if (!isRecord(data) || data.schemaVersion !== 1 || typeof data.ccSessionId !== "string" ||
			!SESSION_ID.test(data.ccSessionId) || data.cwd !== writer.cwd) return undefined;
		return { schemaVersion: 1, ccSessionId: data.ccSessionId, cwd: writer.cwd };
	}
	return undefined;
}

function currentWriter(piSessionId: string | null | undefined, cwd: string): SessionLinkWriter | undefined {
	if (!piSessionId || piSessionId === "(none)") return undefined;
	const writer = writers().get(piSessionId);
	if (!writer || writer.getSessionId() !== piSessionId || writer.cwd !== canonicalCwd(cwd)) return undefined;
	return writer;
}

/** Each extension instance registers its own appendEntry closure. The provider's
 *  first/shared runtime can therefore persist a child's link through the child,
 *  rather than accidentally appending it to the parent's session. */
export function bindSessionLinks(
	pi: Pick<ExtensionAPI, "appendEntry">,
	context: Pick<ExtensionContext, "cwd" | "sessionManager">,
	debug: Debug,
): () => void {
	const manager = context.sessionManager;
	// Partial embedding hosts may omit persistence; their provider still works.
	if (typeof pi.appendEntry !== "function" || typeof manager.getBranch !== "function") return () => {};
	const piSessionId = manager.getSessionId();
	const writer: SessionLinkWriter = {
		piSessionId, cwd: canonicalCwd(context.cwd),
		getSessionId: () => manager.getSessionId(), getBranch: () => manager.getBranch(),
		append: data => pi.appendEntry(SESSION_LINK_TYPE, data),
	};
	writers().set(piSessionId, writer);
	try { debug(`session-link: bound writer pi=${piSessionId} source=${lastBranchLink(writer)?.ccSessionId ?? "none"}`); }
	catch { debug(`WARNING: session-link branch unavailable for pi=${piSessionId}`); }
	return () => {
		if (writers().get(piSessionId) === writer) writers().delete(piSessionId);
	};
}

/** Only a changed current-branch connection adds an entry, never every turn. */
export function recordSessionLink(piSessionId: string | null | undefined, ccSessionId: string, cwd: string, debug: Debug): void {
	if (!SESSION_ID.test(ccSessionId)) return;
	try {
		const writer = currentWriter(piSessionId, cwd);
		if (!writer || lastBranchLink(writer)?.ccSessionId === ccSessionId) return;
		writer.append({ schemaVersion: 1, ccSessionId, cwd: writer.cwd });
		debug(`session-link: append pi=${piSessionId} writer=${writer.piSessionId} cc=${ccSessionId}`);
	} catch { debug(`WARNING: session-link could not be persisted for pi=${piSessionId}`); }
}

/** Read-only rebuild provenance, not a live mirror or permission to resume/delete
 *  that old session. The caller must create a new CC UUID when no mirror exists. */
export function lookupSessionLink(piSessionId: string | null | undefined, cwd: string, debug: Debug): string | undefined {
	try {
		const writer = currentWriter(piSessionId, cwd);
		const link = writer && lastBranchLink(writer);
		if (!link) return undefined;
		const path = getSessionPath(link.ccSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
		if (!lstatSync(dirname(path), { throwIfNoEntry: false })?.isDirectory() ||
			!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return undefined;
		debug(`session-link: source pi=${piSessionId} cc=${link.ccSessionId}`);
		return link.ccSessionId;
	} catch {
		debug(`WARNING: session-link source unavailable for pi=${piSessionId}`);
		return undefined;
	}
}
