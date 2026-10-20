// Apply detected ranges to presentation copies, preserving line breaks and length limits.

export const REDACTION_MARKER = "[REDACTED]";

/** A half-open UTF-16 code-unit range `[start, end)`. */
export type TextRange = readonly [start: number, end: number];

/**
 * Hide every line of `value` separately. Lines at least as long as the marker
 * become the marker, shorter lines become `*` repeated, and CR/LF stay in place,
 * so the replacement never grows the text.
 */
export function hideValue(value: string): string {
    let output = "";
    let lineStart = 0;
    while (lineStart < value.length) {
        const newline = value.indexOf("\n", lineStart);
        const lineEnd = newline === -1 ? value.length : newline + 1;
        let bodyEnd = lineEnd;
        while (
            bodyEnd > lineStart &&
            (value[bodyEnd - 1] === "\n" || value[bodyEnd - 1] === "\r")
        )
            bodyEnd--;
        const bodyLength = bodyEnd - lineStart;
        output +=
            (bodyLength >= REDACTION_MARKER.length
                ? REDACTION_MARKER
                : "*".repeat(bodyLength)) + value.slice(bodyEnd, lineEnd);
        lineStart = lineEnd;
    }
    return output;
}

/** Merge overlapping or touching ranges and hide each merged span. */
export function maskRanges(text: string, ranges: readonly TextRange[]): string {
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
    let output = "";
    let position = 0;
    for (const [start, end] of merged) {
        output +=
            text.slice(position, start) + hideValue(text.slice(start, end));
        position = end;
    }
    return output + text.slice(position);
}
