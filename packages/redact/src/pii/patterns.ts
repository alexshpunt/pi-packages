// Compile catalog patterns and keep candidate boundaries in the original text,
// ported from codemap-search `src/redact/pii/patterns.rs`.
import type { TextRange } from "../transform.js";
import { type CandidateSearch, createCandidateSearch } from "./accelerators.js";
import { createLabelContext, type LabelContext } from "./context.js";
import { translateRustRegex } from "./regex.js";
import { isAscii } from "./validators/checksums.js";
import type { CandidateValidator } from "./validators/index.js";

export interface PiiPatternDefinition {
    readonly name: string;
    readonly regex: string;
    readonly left_boundary: string;
    readonly requires_context: boolean;
    readonly field_regex?: string;
}

export interface PiiRuleDefinition {
    readonly recognizer: string;
    readonly entity: string;
    readonly source: string;
    readonly is_case_insensitive: boolean;
    readonly patterns: readonly PiiPatternDefinition[];
    readonly validator: string;
    readonly context: readonly string[];
}

interface CompiledPattern {
    readonly name: string;
    /** Superset search with `\b` removed, as in the source. */
    readonly search: (text: string) => CandidateSearch;
    /** The original pattern, verified at the candidate start. */
    readonly anchored: RegExp;
    readonly leftBoundary?: RegExp;
    readonly requiresContext: boolean;
    readonly isFieldPattern: boolean;
}

export interface CompiledPiiRule {
    readonly id: string;
    readonly entity: string;
    /** Production detection; label-dependent patterns need `canUseLabels` and a nearby label. */
    detect(text: string, canUseLabels: boolean): TextRange[];
    /** Upstream compatibility search: every non-field pattern, without label checks. */
    find(text: string): TextRange[];
}

function characterLength(text: string, index: number): number {
    const code = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    return code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
        ? 2
        : 1;
}

function previousCharacterLength(text: string, index: number): number {
    const low = text.charCodeAt(index - 1);
    const high = text.charCodeAt(index - 2);
    return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff
        ? 2
        : 1;
}

function regexSearch(search: RegExp): (text: string) => CandidateSearch {
    return (text) => (cursor) => {
        search.lastIndex = cursor;
        return search.exec(text)?.index;
    };
}

function isAsciiUppercaseOrDigit(code: number): boolean {
    return (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39);
}

function isPatternCandidate(
    entity: string,
    name: string,
    value: string,
): boolean {
    switch (entity) {
        case "CREDIT_CARD":
            return !(
                value.startsWith("1") &&
                [...value].length === 13 &&
                /^\p{N}+$/u.test(value)
            );
        case "DE_PLZ":
            return value !== "01000" && value !== "99999";
        case "UK_NINO": {
            const prefix = value.slice(0, 2);
            return !(
                prefix.length === 2 &&
                isAscii(prefix) &&
                ["BG", "GB", "NK", "KN", "NT", "TN", "ZZ"].includes(
                    prefix.toUpperCase(),
                )
            );
        }
        case "IN_PAN":
            return (
                name !== "PAN (Low)" ||
                (/[A-Za-z]/.test(value) && /[0-9]{4}/.test(value))
            );
        case "US_HEALTH_INSURANCE_MEMBER_ID": {
            const length = new TextEncoder().encode(value).length;
            return length >= 6 && length <= 20 && /[0-9]/.test(value);
        }
        default:
            return true;
    }
}

export function compilePiiRule(
    definition: PiiRuleDefinition,
    validator: CandidateValidator,
): CompiledPiiRule {
    const flags = `u${definition.is_case_insensitive ? "i" : ""}s`;
    const translate = (pattern: string) =>
        translateRustRegex(pattern, definition.is_case_insensitive);
    const patterns: CompiledPattern[] = definition.patterns.flatMap((pattern) =>
        [
            [pattern.regex, false] as const,
            ...(pattern.field_regex === undefined
                ? []
                : [[pattern.field_regex, true] as const]),
        ].map(([expression, isFieldPattern]) => ({
            name: pattern.name,
            search:
                createCandidateSearch(expression) ??
                regexSearch(
                    new RegExp(
                        translate(expression.replaceAll("\\b", "")),
                        `${flags}g`,
                    ),
                ),
            anchored: new RegExp(
                `(?<pii_candidate>${translate(expression)})`,
                `${flags}yd`,
            ),
            leftBoundary:
                !isFieldPattern && pattern.left_boundary !== ""
                    ? new RegExp(
                          `^(?:${translate(pattern.left_boundary)})$`,
                          flags,
                      )
                    : undefined,
            requiresContext: pattern.requires_context,
            isFieldPattern,
        })),
    );
    const context: LabelContext = createLabelContext(definition.context);
    const entity = definition.entity;

    function ibanRange(
        text: string,
        start: number,
        candidateEnd: number,
    ): TextRange | undefined {
        let fallback: TextRange | undefined;
        for (let end = candidateEnd; end > start; end--) {
            const isTokenEnd =
                isAsciiUppercaseOrDigit(text.charCodeAt(end - 1)) &&
                (end >= text.length ||
                    !isAsciiUppercaseOrDigit(text.charCodeAt(end)));
            if (!isTokenEnd) continue;
            const value = text.slice(start, end);
            if (!validator.isAccepted(definition.validator, value)) continue;
            if (validator.hasExactIbanLength(value)) return [start, end];
            fallback ??= [start, end];
        }
        return fallback;
    }

    function findFiltered(
        text: string,
        canUseLabels: boolean,
        accepts: (pattern: CompiledPattern, start: number) => boolean,
    ): TextRange[] {
        // Output-only scans cannot accept label-dependent matches. Avoid scanning
        // entire rendered files for candidates that `accepts` would always reject.
        if (
            !canUseLabels &&
            patterns.every(
                (pattern) => pattern.requiresContext || pattern.isFieldPattern,
            )
        )
            return [];
        const ranges: [number, number][] = [];
        for (const pattern of patterns) {
            if (
                !canUseLabels &&
                (pattern.requiresContext || pattern.isFieldPattern)
            )
                continue;
            const search = pattern.search(text);
            let cursor = 0;
            for (;;) {
                const start = search(cursor);
                if (start === undefined) break;
                const nextStart = start + characterLength(text, start);
                pattern.anchored.lastIndex = start;
                const captured = pattern.anchored.exec(text);
                const groups = captured?.indices?.groups;
                const found = groups?.secret ?? groups?.pii_candidate;
                if (!found) {
                    cursor = nextStart;
                    continue;
                }
                const [rangeStart, rangeEnd] = found;
                // Adapted lookarounds may consume a delimiter outside `secret`.
                // Resume at the secret's end so that delimiter remains available.
                cursor = rangeEnd > start ? rangeEnd : nextStart;
                if (pattern.leftBoundary && rangeStart > 0) {
                    const previous = text.slice(
                        rangeStart - previousCharacterLength(text, rangeStart),
                        rangeStart,
                    );
                    if (pattern.leftBoundary.test(previous)) {
                        cursor = nextStart;
                        continue;
                    }
                }
                if (!accepts(pattern, rangeStart)) continue;
                if (entity === "IBAN_CODE") {
                    // A greedy candidate can include the next IBAN's country prefix.
                    // Check every complete token boundary, then resume at the accepted
                    // end instead of skipping the rest of the regex match.
                    const range = ibanRange(text, rangeStart, rangeEnd);
                    if (range) {
                        cursor = range[1];
                        ranges.push([range[0], range[1]]);
                    } else cursor = rangeStart + 1; // IBANs always start with ASCII.
                } else {
                    const value = text.slice(rangeStart, rangeEnd);
                    if (
                        isPatternCandidate(entity, pattern.name, value) &&
                        validator.isAccepted(definition.validator, value)
                    )
                        ranges.push([rangeStart, rangeEnd]);
                }
            }
        }
        ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
        const selected: [number, number][] = [];
        for (const range of ranges) {
            const last = selected.at(-1);
            if (!last || range[1] > last[1]) selected.push(range);
        }
        return selected;
    }

    return Object.freeze({
        id: `pii.${entity.toLowerCase().replaceAll("_", "-")}`,
        entity,
        find: (text: string) =>
            findFiltered(text, true, (pattern) => !pattern.isFieldPattern),
        detect: (text: string, canUseLabels: boolean) =>
            findFiltered(
                text,
                canUseLabels,
                (pattern, start) =>
                    !(pattern.requiresContext || pattern.isFieldPattern) ||
                    (canUseLabels && context(text, start)),
            ).map(([start, end]): TextRange => {
                // URL quotation marks and a trailing VAT separator belong to the
                // surrounding source, not the sensitive value.
                const value = text.slice(start, end);
                if (
                    entity === "URL" &&
                    /^['"]/.test(value) &&
                    /['"]$/.test(value)
                )
                    return [start + 1, end - 1];
                if (entity === "IT_VAT_CODE")
                    return [start, start + value.replace(/[ _]+$/, "").length];
                return [start, end];
            }),
    });
}
