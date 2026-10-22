/**
 * The part of a masked text that analytics keeps: changed lines with a little context.
 * Masking keeps every line break, so the line numbers of the text before and after match.
 */

/** A line around a change. `after` is absent for an unchanged context line. */
export interface ExcerptLine {
  /** 1-based line number in the original text. */
  readonly line: number;
  readonly before: string;
  readonly after?: string;
}

export interface Excerpt {
  /** Lines in order; `null` marks lines that were skipped. */
  readonly lines: readonly (ExcerptLine | null)[];
  /** Lines that masking changed, including any beyond the stored limit. */
  readonly changedLines: number;
  /** Whether lines were left out because the excerpt reached its size limit. */
  readonly isTruncated: boolean;
}

const CONTEXT_LINES = 2;
const MAX_EXCERPT_LINES = 300;
const MAX_LINE_CHARACTERS = 400;
/** Unchanged characters kept on each side of a change in a long line. */
const KEPT_AROUND_CHANGE = 80;
const MAX_CHANGE_CHARACTERS = 1_000;
const ELLIPSIS = "…";
const EXCERPT_VERSION = 1;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** `text.slice(start, end)` moved inward so it never splits a surrogate pair. */
function safeSlice(text: string, start: number, end = text.length): string {
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) start++;
  if (end > 0 && end < text.length && isLowSurrogate(text.charCodeAt(end))) end--;
  return text.slice(start, Math.max(start, end));
}

function splitLines(text: string): string[] {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function cropUnchanged(line: string): string {
  return line.length > MAX_LINE_CHARACTERS ? safeSlice(line, 0, MAX_LINE_CHARACTERS) + ELLIPSIS : line;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) length++;
  if (length > 0 && isHighSurrogate(left.charCodeAt(length - 1))) length--;
  return length;
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  const limit = Math.min(left.length, right.length) - prefixLength;
  let length = 0;
  while (length < limit && left[left.length - 1 - length] === right[right.length - 1 - length]) length++;
  if (length > 0 && isLowSurrogate(left.charCodeAt(left.length - length))) length--;
  return length;
}

/** Crop a long changed line to its changed middle plus some unchanged text on each side. */
function cropChanged(before: string, after: string): [string, string] {
  if (before.length <= MAX_LINE_CHARACTERS && after.length <= MAX_LINE_CHARACTERS) return [before, after];
  const prefixLength = commonPrefixLength(before, after);
  const suffixLength = commonSuffixLength(before, after, prefixLength);
  const head = before.slice(0, prefixLength);
  const tail = before.slice(before.length - suffixLength);
  const keptHead =
    head.length > KEPT_AROUND_CHANGE ? ELLIPSIS + safeSlice(head, head.length - KEPT_AROUND_CHANGE) : head;
  const keptTail = tail.length > KEPT_AROUND_CHANGE ? safeSlice(tail, 0, KEPT_AROUND_CHANGE) + ELLIPSIS : tail;
  const middle = (text: string) => {
    const changed = text.slice(prefixLength, text.length - suffixLength);
    return changed.length > MAX_CHANGE_CHARACTERS ? safeSlice(changed, 0, MAX_CHANGE_CHARACTERS) + ELLIPSIS : changed;
  };
  return [keptHead + middle(before) + keptTail, keptHead + middle(after) + keptTail];
}

/** Changed lines of `before` → `after` with `CONTEXT_LINES` lines of context, bounded in size. */
export function buildExcerpt(before: string, after: string): Excerpt {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const lineCount = Math.max(beforeLines.length, afterLines.length);
  const lineAt = (lines: string[], index: number) => lines[index] ?? "";
  const changed: number[] = [];
  for (let index = 0; index < lineCount; index++)
    if (lineAt(beforeLines, index) !== lineAt(afterLines, index)) changed.push(index);

  const lines: (ExcerptLine | null)[] = [];
  let lastIncluded = -1;
  let storedLines = 0;
  let isTruncated = false;
  for (const changedIndex of changed) {
    const start = Math.max(changedIndex - CONTEXT_LINES, lastIncluded + 1);
    const end = Math.min(changedIndex + CONTEXT_LINES, lineCount - 1);
    if (start > lastIncluded + 1) lines.push(null);
    for (let index = start; index <= end; index++) {
      if (storedLines >= MAX_EXCERPT_LINES) {
        isTruncated = true;
        break;
      }
      const original = lineAt(beforeLines, index);
      const masked = lineAt(afterLines, index);
      if (original === masked) lines.push({ line: index + 1, before: cropUnchanged(original) });
      else {
        const [croppedBefore, croppedAfter] = cropChanged(original, masked);
        lines.push({ line: index + 1, before: croppedBefore, after: croppedAfter });
      }
      lastIncluded = index;
      storedLines++;
    }
    if (isTruncated) break;
  }
  if (lastIncluded < lineCount - 1 && lines.length > 0) lines.push(null);
  return { lines, changedLines: changed.length, isTruncated };
}

export function encodeExcerpt(excerpt: Excerpt): string {
  return JSON.stringify({
    v: EXCERPT_VERSION,
    changed: excerpt.changedLines,
    truncated: excerpt.isTruncated,
    lines: excerpt.lines.map((line) =>
      line === null ? null : line.after === undefined ? [line.line, line.before] : [line.line, line.before, line.after],
    ),
  });
}

/** `undefined` for data this version cannot read. */
export function decodeExcerpt(json: string): Excerpt | undefined {
  try {
    const value = JSON.parse(json) as { v?: unknown; changed?: unknown; truncated?: unknown; lines?: unknown };
    if (value.v !== EXCERPT_VERSION || !Array.isArray(value.lines)) return undefined;
    const lines: (ExcerptLine | null)[] = [];
    for (const entry of value.lines) {
      if (entry === null) lines.push(null);
      else if (
        Array.isArray(entry) &&
        Number.isSafeInteger(entry[0]) &&
        typeof entry[1] === "string" &&
        (entry[2] === undefined || typeof entry[2] === "string")
      )
        lines.push(
          entry[2] === undefined
            ? { line: entry[0], before: entry[1] }
            : { line: entry[0], before: entry[1], after: entry[2] },
        );
      else return undefined;
    }
    const changedLines = Number.isSafeInteger(value.changed) ? (value.changed as number) : 0;
    return { lines, changedLines, isTruncated: value.truncated === true };
  } catch {
    return undefined;
  }
}

/**
 * The excerpt in the line format of Pi's diff renderer: `-N text` for the original line,
 * `+N text` for the masked line, ` N text` for context, and `...` for skipped lines.
 */
export function excerptDiffText(excerpt: Excerpt): string {
  const width = String(Math.max(1, ...excerpt.lines.map((line) => line?.line ?? 1))).length;
  const number = (line: number) => String(line).padStart(width, " ");
  const output: string[] = [];
  for (const line of excerpt.lines) {
    if (line === null) output.push(` ${" ".repeat(width)} ...`);
    else if (line.after === undefined) output.push(` ${number(line.line)} ${line.before}`);
    else output.push(`-${number(line.line)} ${line.before}`, `+${number(line.line)} ${line.after}`);
  }
  return output.join("\n");
}
