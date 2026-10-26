import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
    buildSessionProjection,
    type ExtensionContext,
    type SessionEntry,
    type SessionHeader,
    type SessionProjection,
} from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "./config.js";
import { isSourceEligible } from "./config.js";
import { MemoryFailure } from "./failure.js";
import {
    observeRepository,
    type RepositoryObservation,
    repositoryPath,
    repositoryScope,
} from "./repositories.js";
import {
    canonicalCwd,
    digest,
    jsonStringBytes,
    truncateMiddleBytes,
    workspaceScope,
} from "./safety.js";
import type { RolloutSource } from "./store.js";

export const ORIGIN_ENTRY = "pi-codex-memory.origin";
/** Version 2 records `exposure`; version-1 markers prove only that some memory context was received. */
export const RECALL_ENTRY = "pi-codex-memory.recall";
export type MemoryExposure = "local" | "external";
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const HARNESS_TOOL = /(?:pi_codex_memory|subagent|contact_supervisor)/i;
const EXTERNAL_OMISSION =
    "Assistant text omitted because it received external repository memory context; not independent evidence and not evidence of task success or failure.";
function strongerExposure(
    current: MemoryExposure | undefined,
    next: MemoryExposure | undefined,
): MemoryExposure | undefined {
    return current === "external" || next === "external"
        ? "external"
        : (current ?? next);
}
/** Identifies the delivered foreign result structure, never a substring inside local memory content. */
function isForeignMemoryResult(message: ToolResultMessage): boolean {
    const tool = /^pi_codex_memory_(list|read|search)$/.exec(
        message.toolName,
    )?.[1];
    if (!tool || message.isError) return false;
    let value: unknown = message.details;
    if (value === undefined) {
        try {
            value = JSON.parse(
                message.content
                    .map((part) => (part.type === "text" ? part.text : ""))
                    .join(""),
            );
        } catch {
            return false;
        }
    }
    const result = (value && typeof value === "object" ? value : {}) as Record<
        string,
        unknown
    > & { repository?: { id?: unknown } };
    if (tool === "list" && Array.isArray(result.repositories))
        return (
            typeof result.current_scope === "string" &&
            typeof result.truncated === "boolean" &&
            (result.repositories as ({ id?: unknown } | null)[]).some(
                (item) =>
                    typeof item?.id === "string" &&
                    item.id !== result.current_scope,
            )
        );
    const hasPayload =
        tool === "read"
            ? typeof result.content === "string"
            : Array.isArray(
                  tool === "search" ? result.matches : result.entries,
              );
    if (
        !hasPayload ||
        typeof result.path !== "string" ||
        !result.path.startsWith("repositories/")
    )
        return false;
    try {
        return repositoryPath(result.path)?.scope === result.repository?.id;
    } catch {
        return false;
    }
}
function entryExposure(entry: SessionEntry): MemoryExposure | undefined {
    if (entry.type === "custom" && entry.customType === RECALL_ENTRY)
        return (entry.data as { exposure?: unknown } | undefined)?.exposure ===
            "external"
            ? "external"
            : "local";
    return entry.type === "message" &&
        entry.message.role === "toolResult" &&
        isForeignMemoryResult(entry.message)
        ? "external"
        : undefined;
}
type SessionEntryLookup = ExtensionContext["sessionManager"]["getEntry"];
/** Inspect provenance only; never add abandoned-branch messages to extraction input. */
function externalSummaryIds(
    branch: readonly SessionEntry[],
    getEntry?: SessionEntryLookup,
): Set<string> {
    const byId = new Map(branch.map((entry) => [entry.id, entry]));
    const lookup = getEntry ?? ((id: string) => byId.get(id));
    const summaries = new Set<string>(),
        safe = new Set<string>();
    for (const summary of branch) {
        if (summary.type !== "branch_summary") continue;
        const pending = [{ id: summary.fromId, isExit: false }],
            visiting = new Set<string>();
        while (pending.length) {
            const frame = pending.pop()!;
            if (frame.isExit) {
                visiting.delete(frame.id);
                safe.add(frame.id);
                continue;
            }
            if (safe.has(frame.id)) continue;
            const entry = lookup(frame.id);
            // Forked/exported histories may omit summary ancestors. Unknown/cyclic
            // provenance is not sufficient to treat a generated summary as local.
            if (
                !entry ||
                visiting.has(frame.id) ||
                entryExposure(entry) === "external"
            ) {
                summaries.add(summary.id);
                break;
            }
            visiting.add(frame.id);
            pending.push({ id: frame.id, isExit: true });
            if (entry.parentId !== null)
                pending.push({ id: entry.parentId, isExit: false });
            if (entry.type === "branch_summary")
                pending.push({ id: entry.fromId, isExit: false });
        }
    }
    return summaries;
}
/** Earlier exposure includes the provenance of summaries carried over from abandoned branches. */
export function branchExposure(
    branch: readonly SessionEntry[],
    getEntry?: SessionEntryLookup,
): MemoryExposure | undefined {
    if (externalSummaryIds(branch, getEntry).size) return "external";
    let exposure: MemoryExposure | undefined;
    for (const entry of branch)
        exposure = strongerExposure(exposure, entryExposure(entry));
    return exposure;
}
export function renderProjection(
    projection: SessionProjection,
    maxBytes: number,
    recalledEntries: ReadonlyMap<string, MemoryExposure> = new Map(),
): string {
    const items: {
        header: string;
        content: string;
        priority: number;
        sizeBytes: number;
        isIncluded: boolean;
        isEvidence: boolean;
    }[] = [];
    let totalBytes = 0;
    let exposure: MemoryExposure | undefined;
    const add = (
        header: string,
        content: string,
        priority: number,
        isEvidence: boolean,
    ) => {
        const sizeBytes = jsonStringBytes(header + content);
        items.push({
            header,
            content,
            priority,
            sizeBytes,
            isIncluded: true,
            isEvidence,
        });
        totalBytes += sizeBytes + (items.length > 1 ? 4 : 0); // JSON-escaped "\n\n".
    };
    for (const { sourceEntry, messages } of projection.entries) {
        if (sourceEntry.type === "custom")
            exposure = strongerExposure(exposure, entryExposure(sourceEntry));
        if (
            sourceEntry.type === "custom_message" ||
            sourceEntry.type === "custom"
        )
            continue;
        for (const message of messages) {
            if (
                message.role !== "user" &&
                message.role !== "assistant" &&
                message.role !== "toolResult" &&
                message.role !== "compactionSummary" &&
                message.role !== "branchSummary"
            )
                continue;
            if (
                message.role === "user" &&
                sourceEntry.type === "message" &&
                exposure !== "external"
            )
                exposure = undefined;
            if (
                message.role === "toolResult" &&
                /^pi_codex_memory_(read|search)$/.test(message.toolName) &&
                !message.isError
            )
                exposure = strongerExposure(exposure, "local");
            if (message.role === "toolResult" && isForeignMemoryResult(message))
                exposure = "external";
            if (
                message.role === "toolResult" &&
                HARNESS_TOOL.test(message.toolName)
            )
                continue;
            const responseExposure = strongerExposure(
                exposure,
                recalledEntries.get(sourceEntry.id),
            );
            if (
                (message.role === "compactionSummary" ||
                    message.role === "branchSummary") &&
                responseExposure === "external"
            ) {
                exposure = "external";
                add(
                    `[entry=${sourceEntry.id}; harness omission notice, NOT source testimony]\n`,
                    "Generated summary omitted because its provenance may include external repository memory; not independent evidence.",
                    0,
                    false,
                );
                continue;
            }
            if (
                message.role === "assistant" &&
                responseExposure === "external"
            ) {
                // Foreign context can shape tool-use turns too. Ordinary tool requests stay as separate,
                // low-priority evidence; their arguments do not show that the call succeeded.
                const calls = message.content
                    .flatMap((part) =>
                        part.type === "toolCall" &&
                        !HARNESS_TOOL.test(part.name)
                            ? [
                                  JSON.stringify({
                                      tool: part.name,
                                      arguments: part.arguments,
                                  }),
                              ]
                            : [],
                    )
                    .join("\n");
                if (
                    message.content.some(
                        (part) => part.type === "text" && part.text.trim(),
                    )
                )
                    add(
                        `[entry=${sourceEntry.id}; harness omission notice, NOT source testimony]\n`,
                        EXTERNAL_OMISSION,
                        0,
                        false,
                    );
                if (calls)
                    add(
                        `[entry=${sourceEntry.id}; assistant; outcome=${message.stopReason}]\n`,
                        calls,
                        0,
                        true,
                    );
                continue;
            }
            // Explain the omission without recycling the response or implying task completion.
            const isRecallResponse =
                message.role === "assistant" &&
                message.stopReason === "stop" &&
                !!responseExposure;
            const isGenerated =
                message.role === "compactionSummary" ||
                message.role === "branchSummary" ||
                sourceEntry.type === "compaction" ||
                sourceEntry.type === "branch_summary";
            const isAnswer =
                message.role === "toolResult" &&
                message.toolName === "ask_user_question";
            const content = isRecallResponse
                ? "Assistant response omitted because it received memory context; not independent evidence and not evidence of task success or failure."
                : message.role === "compactionSummary" ||
                    message.role === "branchSummary"
                  ? message.summary
                  : typeof message.content === "string"
                    ? message.content
                    : message.content
                          .filter(
                              (part) =>
                                  part.type === "text" ||
                                  part.type === "toolCall",
                          )
                          .map((part) =>
                              part.type === "text"
                                  ? part.text
                                  : part.type === "toolCall" &&
                                      !HARNESS_TOOL.test(part.name)
                                    ? JSON.stringify({
                                          tool: part.name,
                                          arguments: part.arguments,
                                      })
                                    : "",
                          )
                          .join("\n");
            if (!content.trim()) continue;
            const provenance = isRecallResponse
                ? "harness omission notice, NOT source testimony"
                : isGenerated
                  ? `${message.role}: generated summary, NOT direct human testimony`
                  : message.role === "user"
                    ? "human user"
                    : isAnswer
                      ? "toolResult tool=ask_user_question; reported human answer, scoped to this task"
                      : message.role === "toolResult"
                        ? `toolResult tool=${message.toolName}`
                        : message.role;
            const status = isRecallResponse
                ? ""
                : message.role === "assistant"
                  ? `; outcome=${message.stopReason}`
                  : message.role === "toolResult"
                    ? `; isError=${message.isError}`
                    : "";
            const header = `[entry=${sourceEntry.id}; ${provenance}${status}]\n`;
            const priority = isRecallResponse
                ? 0
                : (message.role === "user" && !isGenerated) || isAnswer
                  ? 3
                  : isGenerated ||
                      (message.role === "assistant" &&
                          message.stopReason === "stop")
                    ? 2
                    : message.role === "toolResult" &&
                        Buffer.byteLength(content) <= 1024
                      ? 1
                      : 0;
            add(header, content, priority, !isRecallResponse);
        }
    }
    if (!items.some((item) => item.isEvidence)) return "";
    const render = () =>
        items
            .filter((item) => item.isIncluded)
            .map((item) => item.header + item.content)
            .join("\n\n");
    if (totalBytes <= maxBytes) return render();
    const marker =
        "[History budget: tool/assistant evidence was shortened or omitted. Missing evidence is unknown; never infer refusal or permission.]\n\n";
    const availableBytes = maxBytes - jsonStringBytes(marker);
    if (availableBytes < 0) throw new MemoryFailure("input_budget");
    let count = items.length;
    const shorten = (index: number, limitBytes: number) => {
        const item = items[index]!;
        const content = truncateMiddleBytes(item.content, limitBytes);
        const sizeBytes = jsonStringBytes(item.header + content);
        totalBytes += sizeBytes - item.sizeBytes;
        item.content = content;
        item.sizeBytes = sizeBytes;
    };
    const omit = (index: number) => {
        const item = items[index]!;
        totalBytes -= item.sizeBytes + (count > 1 ? 4 : 0);
        item.isIncluded = false;
        count--;
    };
    // Prefer retaining both chronological endpoints within each lower-priority class.
    const middleFirst = items
        .map((_, index) => index)
        .sort(
            (a, b) =>
                Math.abs(a - (items.length - 1) / 2) -
                Math.abs(b - (items.length - 1) / 2),
        );
    for (const priority of [0, 1]) {
        for (const index of middleFirst) {
            if (totalBytes <= availableBytes) break;
            if (items[index]!.priority === priority) shorten(index, 2048);
        }
        for (const index of middleFirst) {
            if (totalBytes <= availableBytes) break;
            if (items[index]!.priority === priority) omit(index);
        }
    }
    for (const index of middleFirst) {
        if (totalBytes <= availableBytes) break;
        if (items[index]!.priority === 2) shorten(index, 2048);
    }
    for (const index of middleFirst) {
        if (totalBytes <= availableBytes) break;
        if (items[index]!.priority === 2) omit(index);
    }
    // Do not silently erase human decisions when even the protected inputs exceed the budget.
    if (totalBytes > availableBytes) throw new MemoryFailure("input_budget");
    return marker + render();
}
function extractionProjection(
    branch: readonly SessionEntry[],
): SessionProjection {
    const editedIds = new Set(
        branch
            .filter((entry) => entry.type === "context_edit")
            .map((entry) => entry.targetId),
    );
    // This is a request-local view, not a rewritten session graph. Keep every id/parent
    // link and let the public SDK apply branch-local context edits. An edited
    // compaction remains a barrier, including in imported/hand-edited session files.
    const entries = branch.map(
        (entry): SessionEntry =>
            entry.type === "compaction" && !editedIds.has(entry.id)
                ? {
                      type: "custom",
                      id: entry.id,
                      parentId: entry.parentId,
                      timestamp: entry.timestamp,
                      customType: "pi-codex-memory.compaction-boundary",
                  }
                : entry,
    );
    return buildSessionProjection(entries, branch.at(-1)?.id ?? null);
}
function sessionRepository(
    branch: readonly SessionEntry[],
): RepositoryObservation | undefined {
    for (const entry of branch) {
        if (entry.type !== "custom" || entry.customType !== ORIGIN_ENTRY)
            continue;
        const data = entry.data as
            | {
                  version?: number;
                  isInteractiveRoot?: boolean;
                  repository?: RepositoryObservation;
              }
            | undefined;
        if (data?.version !== 3 || data.isInteractiveRoot !== true) continue;
        const value = data.repository;
        if (
            value?.binding === "session_start" &&
            typeof value.scope === "string" &&
            /^repository-[a-f0-9]{24}$/.test(value.scope) &&
            typeof value.commonDirectory === "string" &&
            typeof value.worktreeRoot === "string" &&
            Number.isSafeInteger(value.capturedAtMs) &&
            (value.branchAtCapture === null ||
                typeof value.branchAtCapture === "string") &&
            repositoryScope(value.commonDirectory) === value.scope
        )
            return {
                scope: value.scope,
                commonDirectory: value.commonDirectory,
                worktreeRoot: value.worktreeRoot,
                branchAtCapture: value.branchAtCapture,
                capturedAtMs: value.capturedAtMs,
                binding: "session_start",
            };
    }
    return undefined;
}
export function sourceScope(
    source: Pick<RolloutSource, "cwd" | "repository">,
): string {
    return source.repository?.scope ?? workspaceScope(source.cwd);
}
/** Fingerprints exclude checkout state, so a source that moved to another scope is compared separately. */
export function isSameSource(
    latest: RolloutSource | null,
    source: RolloutSource,
): boolean {
    return (
        !!latest &&
        latest.fingerprint === source.fingerprint &&
        sourceScope(latest) === sourceScope(source)
    );
}
function snapshot(
    header: SessionHeader,
    file: string,
    maxBytes: number,
    branch: readonly SessionEntry[],
    getEntry: SessionEntryLookup,
    fallbackTimeMs: number,
    expectedScope?: string,
    requireBinding = false,
): RolloutSource | null {
    // Missing ancestry cannot establish which original evidence is safe to recover.
    if (!branch.length || branch[0]!.parentId !== null) return null;
    const bound = sessionRepository(branch),
        observed = observeRepository(header.cwd);
    // The current checkout only verifies membership; later checkouts must not rewrite session-start provenance.
    if (bound && observed && bound.scope !== observed.scope) return null;
    const repository = bound ?? observed;
    if (requireBinding && expectedScope?.startsWith("repository-") && !bound)
        return null;
    if (
        expectedScope &&
        expectedScope !== "global" &&
        sourceScope({
            cwd: header.cwd,
            ...(repository ? { repository } : {}),
        }) !== expectedScope
    )
        return null;
    const projection = extractionProjection(branch);
    const recalledEntries = new Map<string, MemoryExposure>();
    const externalSummaries = externalSummaryIds(branch, getEntry);
    let exposure: MemoryExposure | undefined;
    for (const entry of branch) {
        if (
            entry.type === "message" &&
            entry.message.role === "user" &&
            exposure !== "external"
        )
            exposure = undefined;
        exposure = strongerExposure(
            exposure,
            externalSummaries.has(entry.id) ? "external" : entryExposure(entry),
        );
        if (
            exposure &&
            ((entry.type === "message" && entry.message.role === "assistant") ||
                entry.type === "branch_summary" ||
                entry.type === "compaction")
        )
            recalledEntries.set(entry.id, exposure);
    }
    const text = renderProjection(projection, maxBytes, recalledEntries);
    if (!text) return null;
    const last = [...branch]
        .reverse()
        .find(
            (entry) =>
                entry.type === "message" ||
                entry.type === "context_edit" ||
                entry.type === "branch_summary",
        );
    const leafId = last?.id ?? null;
    const updatedAtMs = last ? Date.parse(last.timestamp) : fallbackTimeMs;
    return {
        id: header.id,
        cwd: canonicalCwd(header.cwd),
        file,
        leafId,
        updatedAtMs: Number.isFinite(updatedAtMs)
            ? updatedAtMs
            : fallbackTimeMs,
        fingerprint: digest(JSON.stringify({ version: 4, leafId, text })),
        text,
        ...(repository ? { repository } : {}),
    };
}
export function currentSource(
    manager: ExtensionContext["sessionManager"],
    maxBytes: number,
    nowMs = Date.now(),
): RolloutSource | null {
    const header = manager.getHeader();
    if (!header) return null;
    return snapshot(
        header,
        manager.getSessionFile() ?? "",
        maxBytes,
        manager.getBranch(),
        (id) => manager.getEntry(id),
        nowMs,
    );
}
export async function readSource(
    path: string,
    maxBytes: number,
    signal: AbortSignal,
    requireOrigin: boolean,
    expectedScope?: string,
    isCwdExcluded?: (cwd: string) => boolean,
): Promise<RolloutSource | null> {
    signal.throwIfAborted();
    const stat = await lstat(path);
    if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > MAX_SESSION_BYTES
    )
        return null;
    const text = await readFile(path, { encoding: "utf8", signal });
    // Reject partially written JSONL instead of claiming a truncated snapshot as successful.
    let values: unknown[];
    try {
        values = text
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line));
    } catch {
        return null;
    }
    const header = values[0] as SessionHeader | undefined;
    if (
        header?.type !== "session" ||
        typeof header.id !== "string" ||
        typeof header.cwd !== "string"
    )
        return null;
    if (isCwdExcluded?.(header.cwd)) return null;
    const entries = values.slice(1) as SessionEntry[];
    if (
        entries.some(
            (entry) =>
                !entry ||
                typeof entry.type !== "string" ||
                typeof entry.id !== "string",
        )
    )
        return null;
    const leafId = entries.at(-1)?.id ?? null;
    signal.throwIfAborted();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const seen = new Set<string>();
    let current = leafId ? byId.get(leafId) : undefined;
    const branch: SessionEntry[] = [];
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        branch.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (
        requireOrigin &&
        !branch.some(
            (entry) =>
                entry.type === "custom" &&
                entry.customType === ORIGIN_ENTRY &&
                (entry.data as { isInteractiveRoot?: boolean } | undefined)
                    ?.isInteractiveRoot === true,
        )
    )
        return null;
    return snapshot(
        header,
        path,
        maxBytes,
        branch.reverse(),
        (id) => byId.get(id),
        stat.mtimeMs,
        expectedScope,
        requireOrigin,
    );
}
export async function scanSources(options: {
    agentDir: string;
    cwd: string;
    sessionDir: string;
    scope: string;
    settings: MemorySettings;
    signal: AbortSignal;
    nowMs: number;
    allowUnmarked?: boolean;
    sessionDirectories?: readonly string[];
    isCwdExcluded?: (cwd: string) => boolean;
}): Promise<RolloutSource[]> {
    const { agentDir, sessionDir, scope, settings, signal, nowMs } = options;
    const directories = new Set([
        sessionDir,
        ...(options.sessionDirectories ?? []),
    ]);
    if (scope === "global") {
        const root = join(agentDir, "sessions");
        try {
            for (const entry of (
                await readdir(root, { withFileTypes: true })
            ).slice(0, 1000)) {
                if (entry.isDirectory() && !entry.isSymbolicLink())
                    directories.add(join(root, entry.name));
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    const candidates: { path: string; updatedAtMs: number }[] = [];
    for (const directory of directories) {
        signal.throwIfAborted();
        try {
            if ((await lstat(directory)).isSymbolicLink()) continue;
            for (const entry of (
                await readdir(directory, { withFileTypes: true })
            ).slice(0, 5000)) {
                if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
                const path = join(directory, entry.name);
                const stat = await lstat(path);
                if (
                    stat.size <= MAX_SESSION_BYTES &&
                    isSourceEligible(stat.mtimeMs, nowMs, settings)
                )
                    candidates.push({ path, updatedAtMs: stat.mtimeMs });
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    candidates.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    const sources: RolloutSource[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates.slice(0, 5000)) {
        signal.throwIfAborted();
        const source = await readSource(
            candidate.path,
            settings.maxInputBytes - 8192,
            signal,
            !options.allowUnmarked,
            scope,
            options.isCwdExcluded,
        );
        if (!source || seen.has(source.id)) continue;
        seen.add(source.id);
        sources.push(source);
    }
    return sources;
}
export async function isSourceUnchanged(
    source: RolloutSource,
    signal: AbortSignal,
    maxBytes: number,
): Promise<boolean> {
    if (!source.file) return true;
    return isSameSource(
        await readSource(resolve(source.file), maxBytes, signal, false),
        source,
    );
}
