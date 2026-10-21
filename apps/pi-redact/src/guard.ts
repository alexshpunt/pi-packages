import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isToolCallEventType, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { countMarkers, REDACTION_MARKER } from "./render.js";

/** Model-facing reason for a blocked call. */
export const MASKED_WRITE_REASON =
  `pi-redact blocked this call: ${REDACTION_MARKER} stands for a value that was masked before it reached you, ` +
  "and writing it would replace the real value. Leave the lines that contain it unchanged and edit around them, " +
  "or ask the user to supply the value.";

/** A larger existing file is not read; any added marker in a full rewrite is then blocked. */
const MAX_COMPARED_FILE_BYTES = 32 * 1024 * 1024;

/** Resolve a write path like Pi's file tools: optional `@` prefix, `~`, `file://` URLs, cwd-relative paths. */
function resolveToolPath(path: string, cwd: string): string {
  let normalized = path.startsWith("@") ? path.slice(1) : path;
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  else if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

/** Markers already in the file; an unreadable or oversized file counts none, which blocks conservatively. */
async function countFileMarkers(path: string): Promise<number> {
  try {
    if ((await stat(path)).size > MAX_COMPARED_FILE_BYTES) return 0;
    return countMarkers(await readFile(path, "utf8"));
  } catch {
    return 0;
  }
}

/**
 * What the call would write a masked value into, or `undefined` when it adds no marker.
 * Shell commands are blocked on any marker; file writes and edits only when they add
 * markers, so files that already contain the literal text stay editable.
 */
export async function findMaskedWrite(event: ToolCallEvent, cwd: string): Promise<string | undefined> {
  if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
    const { command } = event.input;
    return typeof command === "string" && command.includes(REDACTION_MARKER) ? `${event.toolName} command` : undefined;
  }
  if (isToolCallEventType("write", event)) {
    const { content, path } = event.input;
    if (typeof content !== "string" || typeof path !== "string") return undefined;
    const added = countMarkers(content);
    if (added === 0) return undefined;
    return added > (await countFileMarkers(resolveToolPath(path, cwd))) ? path : undefined;
  }
  if (isToolCallEventType("edit", event)) {
    const { edits, path } = event.input;
    if (!Array.isArray(edits)) return undefined;
    for (const edit of edits)
      if (typeof edit?.newText === "string" && countMarkers(edit.newText) > countMarkers(String(edit.oldText ?? "")))
        return typeof path === "string" ? path : "edit";
  }
  return undefined;
}
