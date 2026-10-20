// Configuration normalization ported from codemap-search `src/config/redact.rs`.
// Issues name a key and an index only: never a pattern, an exception value, or a
// RegExp parser message, because configuration may itself contain credentials.
import { isSupportedPiiEntity } from "./pii/index.js";
import { normalizeFieldName, regexMatcher, type SpanMatcher } from "./rules.js";

export interface RedactionRuleConfig {
    /** `custom.` followed by letters, digits, `.`, `_`, or `-`. */
    readonly id: string;
    /** JavaScript RegExp source; a participating `secret` named group limits masking to that group. */
    readonly pattern: string;
    /** Any of `i`, `m`, `s`, `u`, each at most once. The engine adds `d` and `g`. */
    readonly flags?: string;
}

export interface RedactionExceptionConfig {
    readonly ruleId: string;
    /** The entire original value the rule matched. */
    readonly value: string;
}

export interface RedactionConfig {
    readonly sensitiveFields?: readonly string[];
    readonly rules?: readonly RedactionRuleConfig[];
    readonly exceptions?: readonly RedactionExceptionConfig[];
    readonly piiEntities?: readonly string[];
}

export interface NormalizedRedactionConfig {
    readonly sensitiveFields: readonly string[];
    readonly rules: readonly RedactionRuleConfig[];
    readonly exceptions: readonly RedactionExceptionConfig[];
    readonly piiEntities: readonly string[];
}

export interface RedactionConfigIssue {
    readonly key: string;
    readonly index?: number;
    readonly message: string;
}

export interface RedactionConfigNormalization {
    readonly config: NormalizedRedactionConfig;
    readonly issues: readonly RedactionConfigIssue[];
}

/** Rules a host registers in code; ids use the `host.` namespace, separate from user `custom.` rules. */
export interface HostRedactionRule {
    readonly id: string;
    readonly pattern: string;
    readonly flags?: string;
}

export interface HostRedactionAdditions {
    readonly rules?: readonly HostRedactionRule[];
    /** Field names matched exactly after normalization, like user `sensitiveFields`. */
    readonly sensitiveFields?: readonly string[];
}

export function formatIssue(issue: RedactionConfigIssue): string {
    return `${issue.key}${issue.index === undefined ? "" : `[${issue.index}]`}: ${issue.message}`;
}

export class RedactionConfigError extends Error {
    readonly issues: readonly RedactionConfigIssue[];
    constructor(issues: readonly RedactionConfigIssue[]) {
        super(
            `Invalid redaction configuration: ${issues.map(formatIssue).join("; ")}`,
        );
        this.name = "RedactionConfigError";
        this.issues = Object.freeze([...issues]);
    }
}

export const EMPTY_REDACTION_CONFIG: NormalizedRedactionConfig = Object.freeze({
    sensitiveFields: Object.freeze([]),
    rules: Object.freeze([]),
    exceptions: Object.freeze([]),
    piiEntities: Object.freeze([]),
});

const USER_RULE_ID = /^custom\.[A-Za-z0-9._-]+$/;
const HOST_RULE_ID = /^host\.[A-Za-z0-9._-]+$/;
const USER_FLAGS = /^(?!.*(.).*\1)[imsu]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PatternFailure = "invalid" | "empty-match";

/** Compile a configured pattern, reporting only a value-free failure kind. */
export function compilePattern(
    pattern: string,
    flags: string,
): SpanMatcher | PatternFailure {
    let probe: RegExp;
    try {
        probe = new RegExp(pattern, flags);
    } catch {
        return "invalid";
    }
    if (probe.test("")) return "empty-match";
    return regexMatcher(pattern, flags);
}

const patternMessages: Record<PatternFailure, string> = {
    invalid: "pattern is not a valid JavaScript regular expression",
    "empty-match": "pattern matches the empty string",
};

interface EntryCheck<T> {
    readonly value?: T;
    readonly message?: string;
}

/** Validate every entry; any invalid entry invalidates the whole key, as in the source. */
function checkList<T>(
    key: string,
    input: unknown,
    check: (entry: unknown, index: number) => EntryCheck<T>,
    issues: RedactionConfigIssue[],
): readonly T[] {
    if (input === undefined) return Object.freeze([]);
    if (!Array.isArray(input)) {
        issues.push({ key, message: "must be an array" });
        return Object.freeze([]);
    }
    const values: T[] = [];
    let isValid = true;
    input.forEach((entry, index) => {
        const result = check(entry, index);
        if (result.message !== undefined) {
            issues.push({ key, index, message: result.message });
            isValid = false;
        } else if (result.value !== undefined) values.push(result.value);
    });
    return Object.freeze(isValid ? values : []);
}

function checkFieldName(entry: unknown): EntryCheck<string> {
    if (typeof entry !== "string") return { message: "must be a string" };
    if (normalizeFieldName(entry) === "")
        return { message: "must contain a letter or digit" };
    return { value: entry };
}

function checkRule(
    entry: unknown,
    idFormat: RegExp,
    idMessage: string,
    ids: Set<string>,
): EntryCheck<RedactionRuleConfig> {
    if (!isPlainObject(entry)) return { message: "must be an object" };
    if (
        Object.keys(entry).some(
            (name) => !["id", "pattern", "flags"].includes(name),
        )
    )
        return { message: "allows only id, pattern, and flags" };
    const { id, pattern, flags } = entry;
    if (typeof id !== "string" || !idFormat.test(id))
        return { message: idMessage };
    if (ids.has(id)) return { message: "id is duplicated" };
    ids.add(id);
    if (typeof pattern !== "string")
        return { message: "pattern must be a string" };
    if (
        flags !== undefined &&
        (typeof flags !== "string" || !USER_FLAGS.test(flags))
    )
        return { message: "flags may contain only i, m, s, and u, once each" };
    const compiled = compilePattern(pattern, flags ?? "");
    if (typeof compiled === "string")
        return { message: patternMessages[compiled] };
    return {
        value: Object.freeze(
            flags === undefined ? { id, pattern } : { id, pattern, flags },
        ),
    };
}

function checkException(entry: unknown): EntryCheck<RedactionExceptionConfig> {
    if (!isPlainObject(entry)) return { message: "must be an object" };
    if (Object.keys(entry).some((name) => !["ruleId", "value"].includes(name)))
        return { message: "allows only ruleId and value" };
    const { ruleId, value } = entry;
    if (typeof ruleId !== "string" || ruleId === "")
        return { message: "ruleId must be a non-empty string" };
    if (typeof value !== "string" || value === "")
        return { message: "value must be a non-empty string" };
    return { value: Object.freeze({ ruleId, value }) };
}

function checkPiiEntity(entry: unknown): EntryCheck<string> {
    if (typeof entry !== "string" || !isSupportedPiiEntity(entry))
        return { message: "is not a supported PII entity" };
    return { value: entry };
}

/**
 * Validate user configuration. Invalid keys fall back to an empty list and are
 * reported as issues; unknown keys are reported and ignored.
 */
export function normalizeRedactionConfig(
    input: unknown,
): RedactionConfigNormalization {
    const issues: RedactionConfigIssue[] = [];
    if (input === undefined || input === null)
        return { config: EMPTY_REDACTION_CONFIG, issues };
    if (!isPlainObject(input)) {
        issues.push({ key: "redaction", message: "must be an object" });
        return { config: EMPTY_REDACTION_CONFIG, issues };
    }
    for (const key of Object.keys(input))
        if (
            !["sensitiveFields", "rules", "exceptions", "piiEntities"].includes(
                key,
            )
        )
            issues.push({ key, message: "is not a known key" });
    const ids = new Set<string>();
    const config: NormalizedRedactionConfig = Object.freeze({
        sensitiveFields: checkList(
            "sensitiveFields",
            input.sensitiveFields,
            checkFieldName,
            issues,
        ),
        rules: checkList(
            "rules",
            input.rules,
            (entry) =>
                checkRule(
                    entry,
                    USER_RULE_ID,
                    "id must be custom. followed by letters, digits, '.', '_', or '-'",
                    ids,
                ),
            issues,
        ),
        exceptions: checkList(
            "exceptions",
            input.exceptions,
            checkException,
            issues,
        ),
        piiEntities: checkList(
            "piiEntities",
            input.piiEntities,
            checkPiiEntity,
            issues,
        ),
    });
    return { config, issues: Object.freeze(issues) };
}

export interface NormalizedHostAdditions {
    readonly rules: readonly HostRedactionRule[];
    readonly sensitiveFields: readonly string[];
}

export function normalizeHostAdditions(
    host: HostRedactionAdditions | undefined,
): {
    readonly additions: NormalizedHostAdditions;
    readonly issues: readonly RedactionConfigIssue[];
} {
    const issues: RedactionConfigIssue[] = [];
    const ids = new Set<string>();
    const additions: NormalizedHostAdditions = {
        rules: checkList(
            "host.rules",
            host?.rules,
            (entry) =>
                checkRule(
                    entry,
                    HOST_RULE_ID,
                    "id must be host. followed by letters, digits, '.', '_', or '-'",
                    ids,
                ),
            issues,
        ),
        sensitiveFields: checkList(
            "host.sensitiveFields",
            host?.sensitiveFields,
            checkFieldName,
            issues,
        ),
    };
    return { additions, issues };
}
