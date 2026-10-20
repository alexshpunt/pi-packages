// Rust `regex` treats `\w`, `\b`, and `\s` as Unicode-aware. JavaScript keeps them
// ASCII-only even with the `u` flag, so ported patterns spell the Unicode sets out.

/** Unicode word characters as defined by UTS #18 Annex C, matching Rust `\w`. */
export const WORD_CLASS =
    "\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}";
/** Rust `\b` placed before a word character. */
export const BOUNDARY_BEFORE_WORD = `(?<![${WORD_CLASS}])`;
/** Rust `\b` placed after a word character. */
export const BOUNDARY_AFTER_WORD = `(?![${WORD_CLASS}])`;

const wordCharacter = new RegExp(`^[${WORD_CLASS}]$`, "u");

// Unicode White_Space, which Rust `char::is_whitespace` and `\s` use. JavaScript
// `\s` and `String.prototype.trim` differ: they add U+FEFF and omit U+0085.
const whitespaceCodes = new Set([
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
    0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

export function isWhitespaceAt(text: string, index: number): boolean {
    return whitespaceCodes.has(text.charCodeAt(index));
}

function codePointBefore(text: string, index: number): number | undefined {
    if (index <= 0) return undefined;
    const low = text.charCodeAt(index - 1);
    if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
        const high = text.charCodeAt(index - 2);
        if (high >= 0xd800 && high <= 0xdbff)
            return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
    }
    return low;
}

/** True when a word character at `index` starts a word, like Rust `\b`. */
export function isWordStart(text: string, index: number): boolean {
    const previous = codePointBefore(text, index);
    return (
        previous === undefined ||
        !wordCharacter.test(String.fromCodePoint(previous))
    );
}

export function skipWhitespace(text: string, index: number): number {
    let position = index;
    while (position < text.length && isWhitespaceAt(text, position)) position++;
    return position;
}

/** End of `text[start, end)` after removing trailing Unicode whitespace. */
export function trimmedEnd(text: string, start: number, end: number): number {
    let position = end;
    while (position > start && isWhitespaceAt(text, position - 1)) position--;
    return position;
}

export function isBlank(text: string, start: number, end: number): boolean {
    return skipWhitespace(text, start) >= end;
}
