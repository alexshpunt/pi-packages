// Require a nearby label for ambiguous identifiers without NLP or confidence
// scoring. Ported from codemap-search `src/redact/pii/context.rs`.
import { isWhitespaceAt, WORD_CLASS } from "../unicode.js";

const WORD_BOUNDARY = `(?:(?<=[${WORD_CLASS}])(?![${WORD_CLASS}])|(?<![${WORD_CLASS}])(?=[${WORD_CLASS}]))`;
const SEPARATOR = "[\\p{White_Space}_\\-]*";
const NON_ALPHANUMERIC = /[^\p{Alphabetic}\p{N}]/u;
// The source window is 160 UTF-8 bytes before the value.
const WINDOW_BYTES = 160;

function escapeRegExp(text: string): string {
    return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

function utf8Size(codePoint: number): number {
    return codePoint < 0x80
        ? 1
        : codePoint < 0x800
          ? 2
          : codePoint < 0x10000
            ? 3
            : 4;
}

function windowStart(text: string, start: number): number {
    let bytes = 0;
    let position = start;
    while (position > 0) {
        const low = text.charCodeAt(position - 1);
        const high = position >= 2 ? text.charCodeAt(position - 2) : 0;
        const isPair =
            low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
        const size = isPair ? 4 : utf8Size(low);
        if (bytes + size > WINDOW_BYTES) break;
        bytes += size;
        position -= isPair ? 2 : 1;
    }
    return position;
}

function lastIndexOfAny(text: string, characters: string): number {
    for (let index = text.length - 1; index >= 0; index--)
        if (characters.includes(text[index] ?? "")) return index;
    return -1;
}

export type LabelContext = (text: string, start: number) => boolean;

export function createLabelContext(labels: readonly string[]): LabelContext {
    const alternatives = labels
        .map((label) =>
            label
                .split(NON_ALPHANUMERIC)
                .filter((word) => word !== "")
                .map(escapeRegExp)
                .join(SEPARATOR),
        )
        .filter((label) => label !== "");
    // Optional field suffixes cover memberId / passportNumber without accepting
    // unrelated identifiers such as membershipCount or passportTimeoutMs.
    const pattern = new RegExp(
        `${WORD_BOUNDARY}(?:${alternatives.join("|")})(?:${SEPARATOR}(?:id|number|code|no))?${WORD_BOUNDARY}`,
        "iu",
    );
    return (text, start) => {
        // Keep context in the current field/statement. One preceding line is allowed
        // only when the value starts on its own line after an assignment or label.
        const prefix = text.slice(windowStart(text, start), start);
        let left = lastIndexOfAny(prefix, ";,{}[]") + 1;
        const newline = prefix.lastIndexOf("\n");
        if (newline >= left) {
            let isContinuationEmpty = true;
            for (let index = newline + 1; index < prefix.length; index++)
                if (
                    !isWhitespaceAt(prefix, index) &&
                    !"'\"`".includes(prefix[index] ?? "")
                ) {
                    isContinuationEmpty = false;
                    break;
                }
            let previousEnd = newline;
            while (
                previousEnd > left &&
                isWhitespaceAt(prefix, previousEnd - 1)
            )
                previousEnd--;
            const previous = prefix.slice(left, previousEnd);
            if (
                isContinuationEmpty &&
                (previous.endsWith("=") || previous.endsWith(":"))
            )
                left += previous.lastIndexOf("\n") + 1;
            else left = newline + 1;
        }
        const context = prefix.slice(left);
        const operator = lastIndexOfAny(context, "=:");
        return pattern.test(
            operator === -1 ? context : context.slice(0, operator),
        );
    };
}
