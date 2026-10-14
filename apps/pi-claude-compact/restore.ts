// Post-compact restore (Claude Code's gSe: xur for files, Mur for invoked skills). Plan mode, task
// status, and hook output have no Pi equivalent and are not ported. A file over the per-file budget is
// not cut: like Claude Code's compact_file_reference, only a note pointing at it is restored.
//
// Only files whose read/edit/write *succeeded* in the conversation are re-read: a tool call that a
// permission extension blocked leaves an error result, and must not be replayed here. Files carried
// over from an earlier restore come from that compaction entry's details, never from summary text.

import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const MAX_RESTORED_FILES = 5;
export const MAX_TOKENS_PER_FILE = 5_000;
export const MAX_RESTORED_FILE_TOKENS = 50_000;
export const MAX_TOKENS_PER_SKILL = 5_000;
export const MAX_RESTORED_SKILL_TOKENS = 25_000;
const CHARS_PER_TOKEN = 4;
/** UTF-8 needs at most 4 bytes per char: a larger file has more than MAX_TOKENS_PER_FILE worth of characters. */
const MAX_FILE_READ_BYTES = MAX_TOKENS_PER_FILE * CHARS_PER_TOKEN * 4;

const FILE_TOOLS = new Set(["read", "edit", "write"]);
const READ_TOOLS = new Set(["read"]);
const SKILL_BLOCK = /<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>/g;
export const RESTORE_OPEN_TAG = "<post-compact-restore>";
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export type RestoredFile =
  | { kind: "content"; path: string; text: string }
  /** Too large for the per-file budget: only a pointer to it is restored. */
  | { kind: "reference"; path: string };

export interface RestoredSkill {
  name: string;
  location: string;
  text: string;
  truncated: boolean;
}

export interface Restore {
  files: RestoredFile[];
  skills: RestoredSkill[];
}

/** What the previous claude-compact compaction restored, read from its entry details and summary. */
export interface CarriedRestore {
  files: string[];
  skills: { name: string; location: string; content: string }[];
}

export const EMPTY_CARRIED_RESTORE: CarriedRestore = { files: [], skills: [] };

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function capText(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", maxChars);
  return { text: text.slice(0, cut > maxChars / 2 ? cut : maxChars), truncated: true };
}

/** Pi's resolveToCwd: strip "@", expand "~", accept file:// URLs, normalize unicode spaces. */
export function resolveToolPath(path: string, cwd: string): string {
  let normalized = path.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  else if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function pathArgument(args: Record<string, unknown> | undefined): string | undefined {
  const value = args?.path ?? args?.file_path;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

interface FileTouch {
  /** As the model wrote it, for display. */
  path: string;
  absolute: string;
}

/** Successful calls of `tools` (read/edit/write by default), oldest first, including codemode calls. */
function successfulFileTouches(
  messages: readonly AgentMessage[],
  cwd: string,
  tools: ReadonlySet<string> = FILE_TOOLS,
): FileTouch[] {
  const failedCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "toolResult" && message.isError) failedCalls.add(message.toolCallId);
  }
  const answeredCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "toolResult") answeredCalls.add(message.toolCallId);
  }
  const touches: FileTouch[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "toolCall" || !tools.has(part.name)) continue;
        if (!answeredCalls.has(part.id) || failedCalls.has(part.id)) continue;
        const path = pathArgument(part.arguments);
        if (path) touches.push({ path, absolute: resolveToolPath(path, cwd) });
      }
    } else if (message.role === "toolResult" && message.nestedCalls) {
      for (const call of message.nestedCalls.calls) {
        if (call.status !== "ok" || !tools.has(call.name)) continue;
        const path = pathArgument(call.arguments);
        if (path) touches.push({ path, absolute: resolveToolPath(path, cwd) });
      }
    }
  }
  return touches;
}

function textOf(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" && part.text ? part.text : "")).join("\n");
}

interface SkillUse {
  name: string;
  location: string;
  content: string;
}

/** Skills loaded via /skill:name (a <skill> block in a user turn) or by successfully reading a SKILL.md. */
function skillUses(messages: readonly AgentMessage[]): SkillUse[] {
  const uses: SkillUse[] = [];
  const pendingReads = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "user") {
      for (const match of textOf(message.content).matchAll(SKILL_BLOCK)) {
        uses.push({ name: match[1]!, location: match[2]!, content: match[3]! });
      }
    } else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "toolCall" || part.name !== "read") continue;
        const path = pathArgument(part.arguments);
        if (path?.endsWith("/SKILL.md") || path === "SKILL.md") pendingReads.set(part.id, path);
      }
    } else if (message.role === "toolResult") {
      const path = pendingReads.get(message.toolCallId);
      if (!path) continue;
      pendingReads.delete(message.toolCallId);
      if (message.isError) continue;
      const name = path.split("/").at(-2) ?? path;
      uses.push({ name, location: path, content: textOf(message.content) });
    }
  }
  return uses;
}

/** Skill blocks of the restore section claude-compact appended to a previous summary. */
export function restoredSkillBlocks(summary: string, locations: ReadonlySet<string>): CarriedRestore["skills"] {
  const start = summary.lastIndexOf(RESTORE_OPEN_TAG);
  if (start === -1) return [];
  const skills: CarriedRestore["skills"] = [];
  for (const match of summary.slice(start).matchAll(SKILL_BLOCK)) {
    const location = unescapeAttribute(match[2]!);
    if (locations.has(location)) skills.push({ name: unescapeAttribute(match[1]!), location, content: match[3]! });
  }
  return skills;
}

/** Reads at most MAX_FILE_READ_BYTES; skips non-files and binary content. */
async function readRestorableFile(
  touch: FileTouch,
  signal: AbortSignal | undefined,
): Promise<RestoredFile | undefined> {
  if (signal?.aborted) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(touch.absolute, "r");
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    if (info.size > MAX_FILE_READ_BYTES) return { kind: "reference", path: touch.path };
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return undefined;
    const text = bytes.toString("utf8");
    if (estimateTextTokens(text) > MAX_TOKENS_PER_FILE) return { kind: "reference", path: touch.path };
    return { kind: "content", path: touch.path, text };
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function restoredFileTokens(file: RestoredFile): number {
  return file.kind === "content" ? estimateTextTokens(file.text) : 0;
}

/**
 * Builds the restore for one compaction. `summarized` are the messages folded into the summary,
 * `kept` the verbatim tail. As in Claude Code, a file read in the tail is already visible and is not
 * restored; one only edited or written there still is.
 */
export async function buildRestore(
  cwd: string,
  summarized: readonly AgentMessage[],
  kept: readonly AgentMessage[],
  carried: CarriedRestore,
  signal: AbortSignal | undefined,
): Promise<Restore> {
  const keptSkills = new Set(skillUses(kept).map((use) => use.location));
  const skills: RestoredSkill[] = [];
  const restoredLocations = new Set<string>();
  let skillTokens = 0;
  for (const use of [...carried.skills, ...skillUses(summarized)].reverse()) {
    if (keptSkills.has(use.location) || restoredLocations.has(use.location)) continue;
    restoredLocations.add(use.location);
    const capped = capText(use.content, MAX_TOKENS_PER_SKILL);
    const tokens = estimateTextTokens(capped.text);
    if (skillTokens + tokens > MAX_RESTORED_SKILL_TOKENS) continue;
    skillTokens += tokens;
    skills.push({ name: use.name, location: use.location, ...capped });
  }

  // A SKILL.md read is restored as a skill, never a second time as a file.
  const excluded = new Set([
    ...successfulFileTouches(kept, cwd, READ_TOOLS).map((touch) => touch.absolute),
    ...[...restoredLocations, ...keptSkills].map((location) => resolveToolPath(location, cwd)),
  ]);
  const recent: FileTouch[] = [];
  const seen = new Set<string>();
  const candidates = [
    ...carried.files.map((path) => ({ path, absolute: resolveToolPath(path, cwd) })),
    ...successfulFileTouches(summarized, cwd),
    ...successfulFileTouches(kept, cwd),
  ].reverse();
  for (const touch of candidates) {
    if (seen.has(touch.absolute)) continue;
    seen.add(touch.absolute);
    if (!excluded.has(touch.absolute)) recent.push(touch);
  }

  const files: RestoredFile[] = [];
  let fileTokens = 0;
  const read = await Promise.all(recent.slice(0, MAX_RESTORED_FILES).map((touch) => readRestorableFile(touch, signal)));
  for (const file of read) {
    if (!file) continue;
    const tokens = restoredFileTokens(file);
    if (fileTokens + tokens > MAX_RESTORED_FILE_TOKENS) continue;
    fileTokens += tokens;
    files.push(file);
  }

  return { files, skills };
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function unescapeAttribute(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

export function renderRestore(restore: Restore): string {
  const sections: string[] = [];
  const contents = restore.files.filter((file) => file.kind === "content");
  if (contents.length > 0) {
    const files = contents.map((file) => `<file path="${escapeAttribute(file.path)}">\n${file.text}\n</file>`);
    sections.push(
      `Files you read most recently, re-read from disk after compaction (most recent first). They show the current contents, which may differ from what you saw earlier:\n\n${files.join("\n\n")}`,
    );
  }
  for (const file of restore.files) {
    if (file.kind !== "reference") continue;
    sections.push(
      `Note: ${file.path} was read before the last conversation was summarized, but the contents are too large to include. Use the read tool if you need to access it.`,
    );
  }
  if (restore.skills.length > 0) {
    const skills = restore.skills.map((skill) => {
      const note = skill.truncated ? "\n[truncated: read the skill file for the rest]" : "";
      return `<skill name="${escapeAttribute(skill.name)}" location="${escapeAttribute(skill.location)}">\n${skill.text}${note}\n</skill>`;
    });
    sections.push(`Skills loaded earlier in this session. Their instructions still apply:\n\n${skills.join("\n\n")}`);
  }
  return sections.length === 0 ? "" : `${RESTORE_OPEN_TAG}\n${sections.join("\n\n")}\n</post-compact-restore>`;
}
