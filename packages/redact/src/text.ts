// Conservative assignment fallback ported from codemap-search `src/redact/text.rs`.
// Only this text fallback is ported; tree-sitter syntax decisions are not.
import type { TextRange } from "./transform.js";
import {
    isBlank,
    isWhitespaceAt,
    isWordStart,
    skipWhitespace,
    trimmedEnd,
} from "./unicode.js";

interface Assignment {
    /** Start of the key, which is also the start of the match. */
    readonly start: number;
    readonly keyEnd: number;
    /** End of the whole `key = ` match, before any value. */
    readonly end: number;
}

const KEY_HEAD = /[A-Za-z_]/;

/**
 * Matches of the source regex `\b(?P<key>[A-Za-z_][A-Za-z0-9_.-]*)` + tail.
 * A key always extends to the end of its character run (no shorter key can
 * reach the tail), so the leftmost valid start in each run decides the run.
 */
function* assignments(text: string): Iterable<Assignment> {
    const keyRun = /[A-Za-z0-9_.-]+/g;
    // Equivalent to the source tail `["']?[ \t]*(?::[ \t]*(?:TYPE))?[ \t]*(?:=|:)[ \t]*`
    // with the second whitespace run moved into the optional group, which removes
    // the quadratic backtracking between two adjacent `[ \t]*` runs.
    const tail =
        /["']?[ \t]*(?::[ \t]*(?:&(?:'static[ \t]+)?str|String|string|str)[ \t]*)?(?:=|:)[ \t]*/y;
    for (let run = keyRun.exec(text); run !== null; run = keyRun.exec(text)) {
        const runEnd = run.index + run[0].length;
        let start = -1;
        for (let position = run.index; position < runEnd; position++)
            if (
                KEY_HEAD.test(text[position] ?? "") &&
                isWordStart(text, position)
            ) {
                start = position;
                break;
            }
        if (start === -1) continue;
        tail.lastIndex = runEnd;
        if (!tail.test(text)) continue;
        const end = tail.lastIndex;
        yield { start, keyEnd: runEnd, end };
        keyRun.lastIndex = end;
    }
}

interface Quote {
    readonly openingLength: number;
    readonly delimiter: string;
    readonly hasEscapes: boolean;
}

function quoteAt(text: string, start: number): Quote | undefined {
    for (const delimiter of ['"""', "'''", '"', "'", "`"])
        if (text.startsWith(delimiter, start))
            return {
                openingLength: delimiter.length,
                delimiter,
                hasEscapes: true,
            };
    // Prefixes precede the complete delimiter, including Python triple quotes.
    const prefix = text[start] ?? "";
    if (prefix !== "" && "rRbBfFuU@".includes(prefix))
        for (const delimiter of ['"""', "'''", '"', "'"])
            if (text.startsWith(delimiter, start + 1))
                return {
                    openingLength: 1 + delimiter.length,
                    delimiter,
                    hasEscapes: !"rR@".includes(prefix),
                };
    // Rust raw strings with hash-delimited closing quotes.
    if (prefix === "r") {
        let hashes = 0;
        while (text[start + 1 + hashes] === "#") hashes++;
        if (text[start + 1 + hashes] === '"')
            return {
                openingLength: hashes + 2,
                delimiter: `"${"#".repeat(hashes)}`,
                hasEscapes: false,
            };
    }
    return undefined;
}

function closingQuote(
    text: string,
    bodyStart: number,
    { delimiter, hasEscapes }: Quote,
): number | undefined {
    let skipUntil = 0;
    let from = bodyStart;
    for (;;) {
        const offset = text.indexOf(delimiter, from);
        if (offset === -1) return undefined;
        from = offset + delimiter.length;
        if (offset < skipUntil) continue;
        if (hasEscapes) {
            let escapes = 0;
            while (
                offset - escapes > bodyStart &&
                text[offset - escapes - 1] === "\\"
            )
                escapes++;
            if (escapes % 2 !== 0) continue;
        }
        if (delimiter.length === 1 && text.startsWith(delimiter, offset + 1)) {
            // YAML/SQL single quotes and C# verbatim strings escape by doubling quotes.
            skipUntil = offset + 2;
            continue;
        }
        return offset;
    }
}

/** First index of `pattern` at or after a position, reusing the last answer for later positions. */
function nextIndexFinder(
    text: string,
    pattern: RegExp,
): (position: number) => number {
    let from = -1;
    let found = -1;
    return (position) => {
        if (from !== -1 && from <= position && position <= found) return found;
        pattern.lastIndex = position;
        const match = pattern.exec(text);
        from = position;
        found = match ? match.index : text.length;
        return found;
    };
}

/** Start of the line containing a position, for monotonically increasing positions. */
function lineStartFinder(text: string): (position: number) => number {
    let lastNewline = -1;
    let nextNewline = text.indexOf("\n");
    return (position) => {
        if (position <= lastNewline)
            return text.lastIndexOf("\n", position - 1) + 1;
        while (nextNewline !== -1 && nextNewline < position) {
            lastNewline = nextNewline;
            nextNewline = text.indexOf("\n", nextNewline + 1);
        }
        return lastNewline + 1;
    };
}

function baseName(filePath: string): string {
    const segments = filePath
        .split(/[\\/]/)
        .filter((segment) => segment !== "");
    const name = segments.at(-1) ?? "";
    return name === "." || name === ".." ? "" : name;
}

/** ENV/INI-style files whose line values may contain spaces and punctuation. */
export function isLineConfigPath(filePath: string): boolean {
    const name = baseName(filePath);
    if (name === ".env" || name.startsWith(".env.")) return true;
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 ? name.slice(dot + 1) : undefined;
    return ["env", "ini", "properties", "cfg"].includes(extension ?? "");
}

const NULL_LIKE = new Set(["null", "None", "nil", "true", "false"]);
const YAML_HEADER = /^[|>+\-1-9]*$/;

/**
 * Find values assigned to sensitive keys: quoted bodies, YAML block scalars,
 * ENV/INI line values when the file path says so, and bare values only after
 * an empty, `export`, quote, `{`, or `,` prefix.
 */
export function detectAssignments(
    text: string,
    isSensitiveKey: (key: string) => boolean,
    filePath?: string,
): TextRange[] {
    const isLineConfig = filePath !== undefined && isLineConfigPath(filePath);
    const lineStartOf = lineStartFinder(text);
    const nextNewline = nextIndexFinder(text, /\n/g);
    const nextHash = nextIndexFinder(text, /#/g);
    const nextBareEnd = nextIndexFinder(text, /[\p{White_Space},;})"']/gu);
    const nextParenthesis = nextIndexFinder(text, /\(/g);
    const trimmedEnds = new Map<number, number>();
    const ranges: TextRange[] = [];
    let consumed = 0;
    for (const match of assignments(text)) {
        if (
            match.start < consumed ||
            !isSensitiveKey(text.slice(match.start, match.keyEnd))
        )
            continue;
        const start = isLineConfig
            ? match.end
            : skipWhitespace(text, match.end);
        const lineStart = lineStartOf(match.start);
        const lineEnd = nextNewline(start);
        const quote = quoteAt(text, start);
        let range: TextRange | undefined;
        if (quote) {
            const bodyStart = start + quote.openingLength;
            const end = closingQuote(text, bodyStart, quote) ?? text.length;
            consumed = Math.min(end + quote.delimiter.length, text.length);
            range = [bodyStart, end];
        } else if (text[start] === "|" || text[start] === ">") {
            // `start` holds `|` or `>`, so only the end of the header needs trimming.
            const headerEnd = Math.min(nextHash(start), lineEnd);
            const header = text.slice(
                start,
                trimmedEnd(text, start, headerEnd),
            );
            if (YAML_HEADER.test(header)) {
                let indent = 0;
                while (
                    text[lineStart + indent] === " " ||
                    text[lineStart + indent] === "\t"
                )
                    indent++;
                const bodyStart = Math.min(lineEnd + 1, text.length);
                let end = bodyStart;
                while (end < text.length) {
                    const newline = text.indexOf("\n", end);
                    const nextLine = newline === -1 ? text.length : newline + 1;
                    let spaces = 0;
                    while (
                        text[end + spaces] === " " ||
                        text[end + spaces] === "\t"
                    )
                        spaces++;
                    if (!isBlank(text, end, nextLine) && spaces <= indent)
                        break;
                    end = nextLine;
                }
                consumed = end;
                range = [bodyStart, end];
            }
        } else if (isLineConfig) {
            // ENV/INI punctuation and spaces can belong to a credential. Do not stop
            // at a code-expression separator such as a semicolon.
            const valueEnd = Math.min(nextHash(start), lineEnd);
            let end = trimmedEnds.get(valueEnd);
            if (end === undefined) {
                end = trimmedEnd(text, 0, valueEnd);
                trimmedEnds.set(valueEnd, end);
            }
            if (end > start && text[start] !== "$") range = [start, end];
        } else {
            const end = nextBareEnd(start);
            const bare = text.slice(start, end);
            if (
                isBareValuePrefix(text, lineStart, match.start) &&
                bare !== "" &&
                !NULL_LIKE.has(bare) &&
                !"$[{".includes(bare[0] ?? "") &&
                nextParenthesis(start) >= end
            )
                range = [start, end];
        }
        if (range && range[0] < range[1]) ranges.push(range);
    }
    return ranges;
}

/** The trimmed text before the key is empty, `export`, or ends with a quote, `{`, or `,`. */
function isBareValuePrefix(
    text: string,
    lineStart: number,
    keyStart: number,
): boolean {
    let last = keyStart - 1;
    while (last >= lineStart && isWhitespaceAt(text, last)) last--;
    if (last < lineStart) return true;
    if ("\"'{,".includes(text[last] ?? "")) return true;
    const exportStart = last - "export".length + 1;
    return (
        exportStart >= lineStart &&
        text.startsWith("export", exportStart) &&
        skipWhitespace(text, lineStart) === exportStart
    );
}
