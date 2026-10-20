// Built-in credential rules ported from codemap-search `src/redact/rules.rs`.
import type { Detection, DetectionKind } from "./detection.js";
import type { TextRange } from "./transform.js";
import {
    BOUNDARY_AFTER_WORD as AFTER,
    BOUNDARY_BEFORE_WORD as BEFORE,
    isWordStart,
} from "./unicode.js";

/** Yields masked spans: the `secret` group when it participates, otherwise the whole match. */
export type SpanMatcher = (text: string) => Iterable<TextRange>;

export interface PatternRule {
    readonly id: string;
    readonly kind: DetectionKind;
    readonly match: SpanMatcher;
}

/** Wrap a RegExp so a non-empty participating `secret` group limits the masked span. */
export function regexMatcher(source: string, flags: string): SpanMatcher {
    const pattern = new RegExp(source, `${flags}dg`);
    return function* (text) {
        for (const found of text.matchAll(pattern)) {
            const whole = found.indices?.[0];
            const secret = found.indices?.groups?.secret;
            const [start, end] =
                secret && secret[0] < secret[1] ? secret : (whole ?? [0, 0]);
            if (start < end) yield [start, end];
        }
    };
}

function sticky(source: string, flags = "u"): RegExp {
    return new RegExp(source, `${flags}y`);
}

/** End of the (possibly empty) run that a sticky `X*` pattern matches at `position`. */
function runEnd(pattern: RegExp, text: string, position: number): number {
    pattern.lastIndex = position;
    pattern.exec(text);
    return pattern.lastIndex;
}

/**
 * Remember the last maximal run so restarts inside it reuse its end. Starts
 * that share one run then cost O(1) instead of rescanning it, which keeps
 * backtracking-free matching linear where Rust `regex` was linear.
 */
function runScanner(
    text: string,
    pattern: RegExp,
): (position: number) => number {
    let from = -1;
    let end = -1;
    return (position) => {
        if (from !== -1 && from <= position && position <= end) return end;
        from = position;
        end = runEnd(pattern, text, position);
        return end;
    };
}

// Linear rewrites. The straightforward JavaScript translations below (kept as
// references for differential tests) backtrack quadratically when many starts
// share one run, e.g. `eyJ-eyJ-…` or `a.a.a…://`.
export const REFERENCE_PATTERNS = {
    "token.jwt": {
        source: String.raw`${BEFORE}eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`,
        flags: "u",
    },
    "credential.url-password": {
        source: String.raw`${BEFORE}[a-z][a-z0-9+.\-]*://[^\p{White_Space}/:@]+:(?<secret>[^\p{White_Space}/@]+)@`,
        flags: "iu",
    },
    "credential.webhook-url": {
        source: String.raw`${BEFORE}https?://[^\p{White_Space}/"'${"`"}<>]+/(?:[^\p{White_Space}?#"'${"`"}<>]*/)?hooks/(?<secret>[A-Za-z0-9_\-]{16,}(?:[/?#][^\p{White_Space}"'${"`"}<>]*)?)`,
        flags: "iu",
    },
} as const;

const JWT_SEGMENT = sticky("[A-Za-z0-9_\\-]*");

function* matchJwt(text: string): Iterable<TextRange> {
    const header = runScanner(text, JWT_SEGMENT);
    const payload = runScanner(text, JWT_SEGMENT);
    const signature = runScanner(text, JWT_SEGMENT);
    let resumeAt = 0;
    for (
        let start = text.indexOf("eyJ");
        start !== -1;
        start = text.indexOf("eyJ", start + 1)
    ) {
        if (start < resumeAt || !isWordStart(text, start)) continue;
        const headerEnd = header(start + 3);
        if (headerEnd - (start + 3) < 8 || text[headerEnd] !== ".") continue;
        const payloadEnd = payload(headerEnd + 1);
        if (payloadEnd === headerEnd + 1 || text[payloadEnd] !== ".") continue;
        const signatureEnd = signature(payloadEnd + 1);
        if (signatureEnd === payloadEnd + 1) continue;
        yield [start, signatureEnd];
        resumeAt = signatureEnd;
    }
}

// `(?i)[a-z]` also matches U+017F (long s) and U+212A (Kelvin sign) through
// Unicode simple case folding, in Rust and in JavaScript with `iu`.
function isSchemeLetter(code: number): boolean {
    return (
        (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x41 && code <= 0x5a) ||
        code === 0x17f ||
        code === 0x212a
    );
}

function isSchemeCharacter(code: number): boolean {
    return (
        isSchemeLetter(code) ||
        (code >= 0x30 && code <= 0x39) ||
        code === 0x2b ||
        code === 0x2e ||
        code === 0x2d
    );
}

const URL_USER = sticky("[^\\p{White_Space}/:@]*");
const URL_SECRET = sticky("[^\\p{White_Space}/@]*");

function* matchUrlPassword(text: string): Iterable<TextRange> {
    let resumeAt = 0;
    let separator = text.indexOf("://");
    while (separator !== -1) {
        // The scheme run cannot contain ':', so it never reaches an earlier separator.
        let runStart = separator;
        while (
            runStart > resumeAt &&
            isSchemeCharacter(text.charCodeAt(runStart - 1))
        )
            runStart--;
        // Every start inside one scheme run shares the same continuation, so the
        // leftmost valid start decides the whole run.
        let start = -1;
        for (let position = runStart; position < separator; position++)
            if (
                isSchemeLetter(text.charCodeAt(position)) &&
                isWordStart(text, position)
            ) {
                start = position;
                break;
            }
        if (start !== -1) {
            const userStart = separator + 3;
            const userEnd = runEnd(URL_USER, text, userStart);
            if (userEnd > userStart && text[userEnd] === ":") {
                const secretStart = userEnd + 1;
                const secretEnd = runEnd(URL_SECRET, text, secretStart);
                if (secretEnd > secretStart && text[secretEnd] === "@") {
                    yield [secretStart, secretEnd];
                    resumeAt = secretEnd + 1;
                    separator = text.indexOf("://", resumeAt);
                    continue;
                }
            }
        }
        separator = text.indexOf("://", separator + 3);
    }
}

const WEBHOOK_START = /https?:\/\//giu;
const WEBHOOK_HOST = sticky("[^\\p{White_Space}/\"'`<>]*");
const WEBHOOK_PATH = sticky("[^\\p{White_Space}?#\"'`<>]*");
const WEBHOOK_HOOK = sticky("hooks/[A-Za-z0-9_\\-]{16}", "iu");
const WEBHOOK_SECRET = sticky("[A-Za-z0-9_\\-]*", "iu");
const WEBHOOK_SUFFIX = sticky("[^\\p{White_Space}\"'`<>]*");

function isHookAt(text: string, position: number): boolean {
    WEBHOOK_HOOK.lastIndex = position;
    return WEBHOOK_HOOK.test(text);
}

function* matchWebhookUrl(text: string): Iterable<TextRange> {
    const pathEnd = runScanner(text, WEBHOOK_PATH);
    let cachedPathFrom = -1;
    let cachedPathEnd = -1;
    let lastHookSlash = -1;
    let resumeAt = 0;
    for (const found of text.matchAll(WEBHOOK_START)) {
        const start = found.index;
        if (start < resumeAt || !isWordStart(text, start)) continue;
        const hostStart = start + found[0].length;
        const hostEnd = runEnd(WEBHOOK_HOST, text, hostStart);
        if (hostEnd === hostStart || text[hostEnd] !== "/") continue;
        const pathStart = hostEnd + 1;
        const end = pathEnd(pathStart);
        // The greedy optional path prefers the last '/' in the run that is
        // followed by a hook; cache it per run so nested URLs stay linear.
        if (end !== cachedPathEnd || pathStart < cachedPathFrom) {
            cachedPathFrom = pathStart;
            cachedPathEnd = end;
            lastHookSlash = -1;
            for (let position = pathStart; position < end; position++)
                if (
                    text.charCodeAt(position) === 0x2f &&
                    isHookAt(text, position + 1)
                )
                    lastHookSlash = position;
        }
        const hookStart =
            lastHookSlash >= pathStart
                ? lastHookSlash + 1
                : isHookAt(text, pathStart)
                  ? pathStart
                  : -1;
        if (hookStart === -1) continue;
        const secretStart = hookStart + "hooks/".length;
        let secretEnd = runEnd(WEBHOOK_SECRET, text, secretStart);
        if (secretEnd < text.length && "/?#".includes(text[secretEnd] ?? ""))
            secretEnd = runEnd(WEBHOOK_SUFFIX, text, secretEnd + 1);
        yield [secretStart, secretEnd];
        resumeAt = secretEnd;
    }
}

/** The 14 regex rules of the source catalog, in source order. */
export const BUILT_IN_RULES: readonly PatternRule[] = [
    {
        id: "token.aws-access-key",
        kind: "token",
        match: regexMatcher(`${BEFORE}(?:AKIA|ASIA)[A-Z0-9]{16}${AFTER}`, "u"),
    },
    {
        id: "token.github",
        kind: "token",
        match: regexMatcher(
            `${BEFORE}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})${AFTER}`,
            "u",
        ),
    },
    {
        id: "token.openai",
        kind: "token",
        match: regexMatcher(String.raw`${BEFORE}sk-[A-Za-z0-9_\-]{16,}`, "u"),
    },
    {
        id: "token.google",
        kind: "token",
        match: regexMatcher(String.raw`${BEFORE}AIza[A-Za-z0-9_\-]{30,}`, "u"),
    },
    {
        id: "token.slack",
        kind: "token",
        match: regexMatcher(
            String.raw`${BEFORE}xox[baprs]-[A-Za-z0-9\-]{10,}`,
            "u",
        ),
    },
    { id: "token.jwt", kind: "token", match: matchJwt },
    {
        id: "token.stripe",
        kind: "token",
        match: regexMatcher(
            `${BEFORE}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`,
            "u",
        ),
    },
    {
        id: "token.gitlab",
        kind: "token",
        match: regexMatcher(
            String.raw`${BEFORE}glpat-[A-Za-z0-9_\-]{20,}`,
            "u",
        ),
    },
    {
        id: "token.npm",
        kind: "token",
        match: regexMatcher(`${BEFORE}npm_[A-Za-z0-9]{20,}`, "u"),
    },
    {
        id: "token.sendgrid",
        kind: "token",
        match: regexMatcher(
            String.raw`${BEFORE}SG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{20,}`,
            "u",
        ),
    },
    {
        id: "credential.authorization",
        kind: "credential",
        match: regexMatcher(
            String.raw`${BEFORE}(?:authorization|proxy[\-_]authorization)["']?[ \t]*[:=][ \t]*["']?(?:Bearer|Basic)[ \t]+(?<secret>[A-Za-z0-9_~+/=.\-]+)`,
            "iu",
        ),
    },
    {
        id: "credential.bearer",
        kind: "credential",
        match: regexMatcher(
            String.raw`${BEFORE}Bearer[ \t]+(?<secret>[A-Za-z0-9_~+/=.\-]{8,})`,
            "u",
        ),
    },
    {
        id: "credential.url-password",
        kind: "credential",
        match: matchUrlPassword,
    },
    {
        id: "credential.webhook-url",
        kind: "credential",
        match: matchWebhookUrl,
    },
];

/** Rule ids of the built-in regex catalog, in source order. */
export const BUILT_IN_RULE_IDS: readonly string[] = Object.freeze(
    BUILT_IN_RULES.map((rule) => rule.id),
);

export const PRIVATE_KEY_RULE_ID = "private-key.pem";

const PEM_BEGIN =
    /-----BEGIN (?<kind>(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY)-----/g;

/** PEM private-key blocks; an unterminated block masks to the end of the text. */
export function detectPrivateKeys(text: string): Detection[] {
    const detections: Detection[] = [];
    // The first END marker at or after a searched position stays valid for later
    // BEGIN markers before it, so repeated unterminated blocks stay linear.
    const endMarkers = new Map<string, { from: number; index: number }>();
    for (const found of text.matchAll(PEM_BEGIN)) {
        const kind = found.groups?.kind ?? "";
        const marker = `-----END ${kind}-----`;
        const beginEnd = found.index + found[0].length;
        let cached = endMarkers.get(kind);
        if (
            !cached ||
            beginEnd < cached.from ||
            (cached.index !== -1 && cached.index < beginEnd)
        ) {
            cached = { from: beginEnd, index: text.indexOf(marker, beginEnd) };
            endMarkers.set(kind, cached);
        }
        detections.push({
            start: found.index,
            end:
                cached.index === -1
                    ? text.length
                    : cached.index + marker.length,
            ruleId: PRIVATE_KEY_RULE_ID,
            kind: "private-key",
        });
    }
    return detections;
}

const SENSITIVE_SUFFIXES = [
    "apikey",
    "token",
    "password",
    "passwd",
    "pwd",
    "secret",
    "secretkey",
    "privatekey",
    "accesskey",
    "accesskeyid",
];

const fieldCharacter = /^[\p{Alphabetic}\p{N}]$/u;

/** Keep letters and digits and lowercase them per code point, like Rust `normalize_field`. */
export function normalizeFieldName(name: string): string {
    let normalized = "";
    for (const character of name)
        if (fieldCharacter.test(character))
            normalized += character.toLowerCase();
    return normalized;
}

export function hasSensitiveSuffix(normalizedName: string): boolean {
    return SENSITIVE_SUFFIXES.some((suffix) => normalizedName.endsWith(suffix));
}
