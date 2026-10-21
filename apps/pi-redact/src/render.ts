/**
 * Replacement for every masked span. The library renders short spans as `*` so its output
 * never grows; this extension always writes the marker so the model, the user, and the
 * write guard can recognize a masked value.
 */
export const REDACTION_MARKER = "{{REDACTED}}";

/** A half-open UTF-16 code-unit range `[start, end)` over the original text. */
export type TextRange = readonly [start: number, end: number];

function mergeRanges(ranges: readonly TextRange[]): [number, number][] {
  const sorted = ranges
    .filter(([start, end]) => start < end)
    .map(([start, end]): [number, number] => [start, end])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: [number, number][] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

/** Replace each line of `[start, end)` with the marker, keeping CR/LF so line numbers stay aligned. */
function markSpan(text: string, start: number, end: number): string {
  let output = "";
  for (let lineStart = start; lineStart < end; ) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 || newline >= end ? end : newline + 1;
    let bodyEnd = lineEnd;
    while (bodyEnd > lineStart && (text[bodyEnd - 1] === "\n" || text[bodyEnd - 1] === "\r")) bodyEnd--;
    output += (bodyEnd > lineStart ? REDACTION_MARKER : "") + text.slice(bodyEnd, lineEnd);
    lineStart = lineEnd;
  }
  return output;
}

/** Merge overlapping or touching ranges and replace them with the marker. Returns `text` itself when nothing changes. */
export function renderMarked(text: string, ranges: readonly TextRange[]): string {
  const merged = mergeRanges(ranges);
  if (merged.length === 0) return text;
  let output = "";
  let position = 0;
  for (const [start, end] of merged) {
    output += text.slice(position, start) + markSpan(text, start, end);
    position = end;
  }
  output += text.slice(position);
  return output === text ? text : output;
}

export function countMarkers(text: string): number {
  let count = 0;
  for (
    let index = text.indexOf(REDACTION_MARKER);
    index !== -1;
    index = text.indexOf(REDACTION_MARKER, index + REDACTION_MARKER.length)
  )
    count++;
  return count;
}
