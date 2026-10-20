// Detection metadata never retains raw values: only a range, a rule id, and a kind.

export type DetectionKind =
    | "sensitive-field"
    | "token"
    | "credential"
    | "private-key"
    | "custom"
    | "host"
    | "pii";

export interface Detection {
    /** UTF-16 code-unit index where the masked span starts. */
    readonly start: number;
    /** UTF-16 code-unit index where the masked span ends (exclusive). */
    readonly end: number;
    readonly ruleId: string;
    readonly kind: DetectionKind;
}

export const SENSITIVE_FIELD_RULE_ID = "field.sensitive";

const kindOrder: Record<DetectionKind, number> = {
    "sensitive-field": 0,
    token: 1,
    credential: 2,
    "private-key": 3,
    custom: 4,
    host: 5,
    pii: 6,
};

export function fieldDetection(start: number, end: number): Detection {
    return {
        start,
        end,
        ruleId: SENSITIVE_FIELD_RULE_ID,
        kind: "sensitive-field",
    };
}

/** Exception values keyed by rule id; a value exempts only that rule's exact match. */
export type ExceptionIndex = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Drop empty detections and exact exceptions, then order by position. An
 * exception compares the whole original span, so a longer value or another
 * rule's overlapping detection stays masked.
 */
export function finishDetections(
    text: string,
    detections: readonly Detection[],
    exceptions: ExceptionIndex,
): Detection[] {
    return detections
        .filter(
            (detection) =>
                detection.start < detection.end &&
                !exceptions
                    .get(detection.ruleId)
                    ?.has(text.slice(detection.start, detection.end)),
        )
        .sort(
            (left, right) =>
                left.start - right.start ||
                left.end - right.end ||
                kindOrder[left.kind] - kindOrder[right.kind] ||
                (left.ruleId < right.ruleId
                    ? -1
                    : left.ruleId > right.ruleId
                      ? 1
                      : 0),
        );
}
