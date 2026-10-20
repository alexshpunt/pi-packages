// Translate the Rust `regex` syntax used by the PII catalog into JavaScript
// RegExp source for the `u` flag. Callers add `i` (case-insensitive entries)
// and `s` (Rust `dot_matches_new_line`); multi-line `^`/`$` are rewritten here
// because JavaScript `m` also treats `\r`, U+2028, and U+2029 as line breaks.
import { WORD_CLASS } from "../unicode.js";

const WORD_BOUNDARY = `(?:(?<=[${WORD_CLASS}])(?![${WORD_CLASS}])|(?<![${WORD_CLASS}])(?=[${WORD_CLASS}]))`;
const NOT_WORD_BOUNDARY = `(?:(?<=[${WORD_CLASS}])(?=[${WORD_CLASS}])|(?<![${WORD_CLASS}])(?![${WORD_CLASS}]))`;
// RegExp syntax characters; only these (and `-` in a class) accept identity escapes with `u`.
const SYNTAX_CHARACTERS = new Set("^$\\.*+?()[]{}|/");
const QUANTIFIER = /^\{\d+(?:,\d*)?\}/;

export class UnsupportedRegexError extends Error {
    constructor(construct: string) {
        super(`Unsupported Rust regex construct: ${construct}`);
        this.name = "UnsupportedRegexError";
    }
}

function literal(character: string, isInClass: boolean): string {
    if (isInClass)
        return "\\]-[^".includes(character) ? `\\${character}` : character;
    return SYNTAX_CHARACTERS.has(character) ? `\\${character}` : character;
}

function codePointAt(pattern: string, index: number): string {
    return String.fromCodePoint(pattern.codePointAt(index) ?? 0);
}

/** Translate one escape; returns the JavaScript text and the consumed length. */
function translateEscape(
    pattern: string,
    index: number,
    isInClass: boolean,
): [translated: string, consumed: number, isLiteral: boolean] {
    const next = pattern[index + 1];
    if (next === undefined)
        throw new UnsupportedRegexError("trailing backslash");
    const classItems: Record<string, string> = {
        d: "\\p{Nd}",
        s: "\\p{White_Space}",
        w: WORD_CLASS,
        n: "\\n",
        t: "\\t",
        r: "\\r",
    };
    if (isInClass) {
        if (next in classItems) return [classItems[next] ?? "", 2, false];
        if (/[A-Za-z0-9]/.test(next))
            throw new UnsupportedRegexError(`\\${next} inside a class`);
        return [literal(next, true), 2, true];
    }
    const items: Record<string, string> = {
        d: "\\p{Nd}",
        D: "\\P{Nd}",
        s: "\\p{White_Space}",
        S: "\\P{White_Space}",
        w: `[${WORD_CLASS}]`,
        W: `[^${WORD_CLASS}]`,
        b: WORD_BOUNDARY,
        B: NOT_WORD_BOUNDARY,
        A: "(?<![\\s\\S])",
        z: "(?![\\s\\S])",
        n: "\\n",
        t: "\\t",
        r: "\\r",
    };
    if (next in items) return [items[next] ?? "", 2, false];
    if (/[A-Za-z0-9]/.test(next)) throw new UnsupportedRegexError(`\\${next}`);
    const character = codePointAt(pattern, index + 1);
    return [literal(character, false), 1 + character.length, true];
}

function translateClass(pattern: string, start: number): [string, number] {
    let index = start + 1;
    let output = "[";
    if (pattern[index] === "^") {
        output += "^";
        index++;
    }
    // A `]` right after the opening bracket is a literal in Rust.
    let isFirst = true;
    let previousLiteral: string | undefined;
    while (index < pattern.length && (pattern[index] !== "]" || isFirst)) {
        const character = pattern[index] ?? "";
        if (character === "[")
            throw new UnsupportedRegexError("nested or POSIX class");
        if (character === "&" && pattern[index + 1] === "&")
            throw new UnsupportedRegexError("class intersection");
        if (
            character === "-" &&
            previousLiteral !== undefined &&
            pattern[index + 1] !== "]" &&
            pattern[index + 1] !== undefined
        ) {
            // A range between two literals.
            let endText: string;
            let consumed: number;
            if (pattern[index + 1] === "\\") {
                const [translated, length, isLiteral] = translateEscape(
                    pattern,
                    index + 1,
                    true,
                );
                if (!isLiteral)
                    throw new UnsupportedRegexError("range to a class escape");
                endText = translated;
                consumed = length;
            } else {
                const endCharacter = codePointAt(pattern, index + 1);
                endText = literal(endCharacter, true);
                consumed = endCharacter.length;
            }
            output += `-${endText}`;
            index += 1 + consumed;
            previousLiteral = undefined;
            isFirst = false;
            continue;
        }
        if (character === "\\") {
            const [translated, consumed, isLiteral] = translateEscape(
                pattern,
                index,
                true,
            );
            output += translated;
            index += consumed;
            previousLiteral = isLiteral ? translated : undefined;
        } else {
            const item = codePointAt(pattern, index);
            output += literal(item, true);
            index += item.length;
            previousLiteral = item === "-" ? undefined : item;
        }
        isFirst = false;
    }
    if (pattern[index] !== "]")
        throw new UnsupportedRegexError("unclosed class");
    return [`${output}]`, index + 1 - start];
}

/**
 * Translate a Rust pattern. `(?i)` is accepted only when the whole pattern is
 * already case-insensitive, because Node.js 22 lacks inline modifier groups.
 */
export function translateRustRegex(
    pattern: string,
    isCaseInsensitive: boolean,
): string {
    let output = "";
    let index = 0;
    while (index < pattern.length) {
        const character = pattern[index] ?? "";
        if (character === "\\") {
            const [translated, consumed] = translateEscape(
                pattern,
                index,
                false,
            );
            output += translated;
            index += consumed;
        } else if (character === "[") {
            const [translated, consumed] = translateClass(pattern, index);
            output += translated;
            index += consumed;
        } else if (character === "(") {
            const rest = pattern.slice(index, index + 4);
            if (rest.startsWith("(?P<")) {
                output += "(?<";
                index += 4;
            } else if (rest.startsWith("(?:")) {
                output += "(?:";
                index += 3;
            } else if (rest.startsWith("(?i)")) {
                if (!isCaseInsensitive)
                    throw new UnsupportedRegexError(
                        "(?i) in a case-sensitive pattern",
                    );
                index += 4;
            } else if (rest.startsWith("(?")) {
                throw new UnsupportedRegexError(rest);
            } else {
                output += "(";
                index++;
            }
        } else if (character === "^") {
            output += "(?<![^\\n])";
            index++;
        } else if (character === "$") {
            output += "(?![^\\n])";
            index++;
        } else if (character === "{") {
            const quantifier = QUANTIFIER.exec(pattern.slice(index));
            output += quantifier ? quantifier[0] : "\\{";
            index += quantifier ? quantifier[0].length : 1;
        } else if (character === "}" || character === "]") {
            output += `\\${character}`;
            index++;
        } else {
            const item = codePointAt(pattern, index);
            output += item;
            index += item.length;
        }
    }
    return output;
}
