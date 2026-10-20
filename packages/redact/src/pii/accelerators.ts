// Linear candidate searches for catalog patterns whose direct JavaScript
// translation backtracks quadratically where Rust `regex` stays linear. Each
// search returns the start the translated superset search would return, and is
// used only while the catalog pattern text is exactly the one it was written for.
import { WORD_CLASS } from "../unicode.js";

/** Start of the leftmost superset-search match at or after `cursor`, if any. */
export type CandidateSearch = (cursor: number) => number | undefined;

const EMAIL_PATTERN =
    "\\b((([!#$%&'*+\\-/=?^_`{|}~\\w])|([!#$%&'*+\\-/=?^_`{|}~\\w][!#$%&'*+\\-/=?^_`{|}~\\.\\w]{0,}[!#$%&'*+\\-/=?^_`{|}~\\w]))[@]\\w+(?:-+\\w+)*(?:\\.\\w+(?:-+\\w+)*)+)\\b";
const EMAIL_LOCAL = new RegExp(`^[!#$%&'*+\\-/=?^_\`{|}~${WORD_CLASS}]$`, "iu");
const EMAIL_DOMAIN = new RegExp(
    `[${WORD_CLASS}]+(?:-+[${WORD_CLASS}]+)*(?:\\.[${WORD_CLASS}]+(?:-+[${WORD_CLASS}]+)*)+`,
    "iuy",
);

function codePointBefore(text: string, index: number): string {
    const low = text.charCodeAt(index - 1);
    const high = text.charCodeAt(index - 2);
    return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff
        ? text.slice(index - 2, index)
        : text.slice(index - 1, index);
}

/**
 * Superset search for `Email (Medium)`. A local part cannot contain `@`, so a
 * match ends its local part at the first `@` after the start, and every start
 * inside one `[L.]` run shares that `@`, its last local character, and its
 * domain. The leftmost start is therefore the first non-dot character of the
 * run at or after the cursor, for the first `@` whose suffix matches.
 */
function emailSearch(text: string): CandidateSearch {
    let cachedFrom = -1;
    let cachedAt = -1;
    let cachedRunStart = -1;
    let isCachedValid = false;
    return (cursor) => {
        let from = cursor + 1;
        for (;;) {
            let at: number;
            if (cachedFrom !== -1 && cachedFrom <= from && from <= cachedAt)
                at = cachedAt;
            else {
                at = text.indexOf("@", from);
                if (at === -1) return undefined;
                cachedFrom = from;
                cachedAt = at;
                isCachedValid = EMAIL_LOCAL.test(codePointBefore(text, at));
                if (isCachedValid) {
                    EMAIL_DOMAIN.lastIndex = at + 1;
                    isCachedValid = EMAIL_DOMAIN.test(text);
                }
                if (isCachedValid) {
                    let runStart = at;
                    while (runStart > 0) {
                        const previous = codePointBefore(text, runStart);
                        if (previous !== "." && !EMAIL_LOCAL.test(previous))
                            break;
                        runStart -= previous.length;
                    }
                    cachedRunStart = runStart;
                }
            }
            if (isCachedValid) {
                let start = Math.max(cachedRunStart, cursor);
                while (text[start] === ".") start++;
                return start;
            }
            from = at + 1;
        }
    };
}

export function createCandidateSearch(
    pattern: string,
): ((text: string) => CandidateSearch) | undefined {
    return pattern === EMAIL_PATTERN ? emailSearch : undefined;
}
