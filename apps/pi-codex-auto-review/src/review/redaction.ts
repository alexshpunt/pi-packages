import {
    createRedactor,
    EMPTY_REDACTION_CONFIG,
    type JsonPathSegment,
    type MaskedLocation,
    type NormalizedRedactionConfig,
    type Redactor,
    SENSITIVE_FIELD_RULE_ID,
} from "@buyong/redact";
import type { Json } from "../contracts.js";

/** Coverage of the 0.3.0 reviewer masking that the shared built-in rules do not include. */
const LEGACY_ADDITIONS = {
    rules: [
        {
            id: "host.synthetic-marker",
            pattern: "SYNTHETIC_[A-Z0-9_:-]+",
            flags: "i",
        },
        {
            id: "host.bearer",
            pattern: "\\bBearer\\s+(?<secret>[^\\s\"']+)",
            flags: "i",
        },
        {
            id: "host.assignment",
            pattern:
                "\\b(?:api[_-]?key|token|password|secret)\\s*[=:]\\s*(?<secret>\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;\"']+)",
            flags: "i",
        },
        {
            id: "host.access-key",
            pattern: "\\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})\\b",
        },
    ],
    sensitiveFields: ["authorization"],
};
/** Keys whose whole value 0.3.0 replaced, including numbers, objects and arrays. */
const LEGACY_SENSITIVE_KEY =
    /^(authorization|api[_-]?key|token|password|secret)$/i;
/** Controller-built envelope fields of context item content; never their nested data. */
const CONTENT_ENVELOPE_KEYS = new Set([
    "toolCallId",
    "callIdentity",
    "parentToolCallId",
    "parentCallIdentity",
    "actionDigest",
    "stage",
    "tool",
    "role",
    "isError",
]);
const REVIEW_RESULT_DIGEST_KEYS = new Set([
    "actionDigest",
    "contextDigest",
    "policyDigest",
]);
const CONTEXT_KEYS = new Set(["sessionId", "contextId", "turnId", "digest"]);
const CONTEXT_ITEM_KEYS = new Set(["id", "source", "trust", "isTruncated"]);
/** Every GuardAction field except the tool arguments and working directory. */
const ACTION_IDENTITY_KEYS = new Set([
    "schemaVersion",
    "toolCallId",
    "tool",
    "source",
    "sessionId",
    "policyRevision",
    "permissionDigest",
    "digest",
]);

const redactors = new WeakMap<NormalizedRedactionConfig, Redactor>();
/** One redactor per validated settings value; settings objects are immutable. */
export function reviewRedactor(
    config: NormalizedRedactionConfig = EMPTY_REDACTION_CONFIG,
): Redactor {
    let redactor = redactors.get(config);
    if (!redactor) {
        redactor = createRedactor(config, LEGACY_ADDITIONS);
        redactors.set(config, redactor);
    }
    return redactor;
}

function isContentEnvelope(
    path: readonly JsonPathSegment[],
    offset: number,
): boolean {
    const length = path.length - offset;
    return (
        (length === 1 && CONTENT_ENVELOPE_KEYS.has(String(path[offset]))) ||
        (length === 2 &&
            path[offset] === "result" &&
            REVIEW_RESULT_DIGEST_KEYS.has(String(path[offset + 1])))
    );
}
/** Structural positions inside one context item's content. */
export function isContentStructure(path: readonly JsonPathSegment[]): boolean {
    return isContentEnvelope(path, 0);
}
/** Structural positions inside the reviewer request data. */
export function isRequestStructure(path: readonly JsonPathSegment[]): boolean {
    const [field, key, , itemKey] = path;
    if (field === "untrustedAction")
        return path.length === 2 && ACTION_IDENTITY_KEYS.has(String(key));
    if (field !== "context") return false;
    if (path.length === 2) return CONTEXT_KEYS.has(String(key));
    if (key !== "items" || typeof path[2] !== "number") return false;
    if (path.length === 4) return CONTEXT_ITEM_KEYS.has(String(itemKey));
    return itemKey === "content" && isContentEnvelope(path, 4);
}

function withholdLegacyValues(
    value: Json,
    path: JsonPathSegment[],
    shouldPreserve: (path: readonly JsonPathSegment[]) => boolean,
    locations: MaskedLocation[],
): Json {
    if (Array.isArray(value))
        return value.map((item, index) =>
            withholdLegacyValues(
                item,
                [...path, index],
                shouldPreserve,
                locations,
            ),
        );
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
            const itemPath = [...path, key];
            if (shouldPreserve(itemPath)) return [key, item];
            // Strings go through the engine, which masks them whole under this key.
            if (LEGACY_SENSITIVE_KEY.test(key) && typeof item !== "string") {
                locations.push({
                    path: itemPath,
                    ruleId: SENSITIVE_FIELD_RULE_ID,
                });
                return [key, "[REDACTED]"];
            }
            return [
                key,
                withholdLegacyValues(item, itemPath, shouldPreserve, locations),
            ];
        }),
    );
}

/**
 * Mask reviewer-bound JSON. Each string is scanned whole so multi-line blocks
 * are found; structural identifiers chosen by position stay unchanged.
 */
export function redactReviewData(
    redactor: Redactor,
    value: Json,
    shouldPreserve: (path: readonly JsonPathSegment[]) => boolean = () => false,
): { value: Json; maskedLocations: readonly MaskedLocation[] } {
    const withheld: MaskedLocation[] = [];
    const prepared = withholdLegacyValues(value, [], shouldPreserve, withheld);
    const masked = redactor.redactJson(prepared, { shouldPreserve });
    return {
        value: masked.value,
        maskedLocations: [...withheld, ...masked.maskedLocations],
    };
}
