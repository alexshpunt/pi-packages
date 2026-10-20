// Immutable redactor instances replace the source's process-global configuration
// and request-scoped activation: callers decide whether to call a redactor.
import {
    compilePattern,
    type HostRedactionAdditions,
    type NormalizedRedactionConfig,
    normalizeHostAdditions,
    normalizeRedactionConfig,
    type RedactionConfig,
    RedactionConfigError,
} from "./config.js";
import {
    type Detection,
    type DetectionKind,
    fieldDetection,
    finishDetections,
} from "./detection.js";
import {
    type RedactJsonOptions,
    type RedactJsonResult,
    redactJsonValue,
} from "./json.js";
import { createPiiDetector } from "./pii/index.js";
import {
    BUILT_IN_RULES,
    detectPrivateKeys,
    hasSensitiveSuffix,
    normalizeFieldName,
    type PatternRule,
} from "./rules.js";
import { detectAssignments } from "./text.js";
import { maskRanges, type TextRange } from "./transform.js";

/**
 * `full` (default) runs every rule, label-aware PII, and the assignment
 * fallback. `context-free` runs only rules that do not depend on surrounding
 * text, for content already rendered from a scanned original.
 */
export type ScanMode = "full" | "context-free";

export interface ScanOptions {
    readonly mode?: ScanMode;
    /** Path hint; `.env`, `.env.*`, `.env`, `.ini`, `.properties`, and `.cfg` files mask whole line values. */
    readonly filePath?: string;
}

/** Detections over one full original text. Render the whole text or any range of it. */
export interface TextScan {
    readonly detections: readonly Detection[];
    render(text: string): string;
    renderRange(text: string, start: number, end: number): string;
}

export interface Redactor {
    readonly config: NormalizedRedactionConfig;
    isSensitiveField(name: string): boolean;
    scan(text: string, options?: ScanOptions): TextScan;
    redactText(text: string, options?: ScanOptions): string;
    /** Like `scan`, plus the whole value when `name` is a sensitive field. */
    scanNamedValue(name: string, value: string): TextScan;
    redactNamedValue(name: string, value: string): string;
    redactJson<T>(value: T, options?: RedactJsonOptions): RedactJsonResult<T>;
}

function renderRange(
    text: string,
    detections: readonly Detection[],
    start: number,
    end: number,
): string {
    const ranges: TextRange[] = [];
    for (const detection of detections) {
        const left = Math.max(detection.start, start);
        const right = Math.min(detection.end, end);
        if (left < right) ranges.push([left - start, right - start]);
    }
    const slice = text.slice(start, end);
    return ranges.length ? maskRanges(slice, ranges) : slice;
}

function createTextScan(detections: readonly Detection[]): TextScan {
    const frozen = Object.freeze(
        detections.map((detection) => Object.freeze({ ...detection })),
    );
    return Object.freeze({
        detections: frozen,
        render: (text: string) => renderRange(text, frozen, 0, text.length),
        renderRange: (text: string, start: number, end: number) =>
            renderRange(text, frozen, start, end),
    });
}

function compileRules(
    rules: readonly { id: string; pattern: string; flags?: string }[],
    kind: DetectionKind,
): PatternRule[] {
    return rules.map(({ id, pattern, flags }) => {
        const match = compilePattern(pattern, flags ?? "");
        if (typeof match === "string")
            throw new RedactionConfigError([
                { key: "rules", message: "pattern is not usable" },
            ]);
        return { id, kind, match };
    });
}

/**
 * Create an immutable redactor. User configuration is validated with
 * `normalizeRedactionConfig`; any issue, or an invalid host addition, throws a
 * `RedactionConfigError` whose message contains keys and indexes only.
 */
export function createRedactor(
    config?: RedactionConfig,
    host?: HostRedactionAdditions,
): Redactor {
    const normalized = normalizeRedactionConfig(config);
    const hostAdditions = normalizeHostAdditions(host);
    const issues = [...normalized.issues, ...hostAdditions.issues];
    if (issues.length) throw new RedactionConfigError(issues);

    const rules: readonly PatternRule[] = [
        ...BUILT_IN_RULES,
        ...compileRules(hostAdditions.additions.rules, "host"),
        ...compileRules(normalized.config.rules, "custom"),
    ];
    const exactFields = new Set(
        [
            ...normalized.config.sensitiveFields,
            ...hostAdditions.additions.sensitiveFields,
        ].map(normalizeFieldName),
    );
    const exceptions = new Map<string, Set<string>>();
    for (const { ruleId, value } of normalized.config.exceptions) {
        const values = exceptions.get(ruleId) ?? new Set<string>();
        values.add(value);
        exceptions.set(ruleId, values);
    }
    const pii = createPiiDetector(normalized.config.piiEntities);

    function isSensitiveField(name: string): boolean {
        const normalizedName = normalizeFieldName(name);
        return (
            hasSensitiveSuffix(normalizedName) ||
            exactFields.has(normalizedName)
        );
    }

    function detectPatterns(text: string, canUseLabels: boolean): Detection[] {
        const detections: Detection[] = [];
        for (const rule of rules)
            for (const [start, end] of rule.match(text))
                detections.push({
                    start,
                    end,
                    ruleId: rule.id,
                    kind: rule.kind,
                });
        detections.push(...detectPrivateKeys(text));
        if (pii) detections.push(...pii.detect(text, canUseLabels));
        return detections;
    }

    function scanDetections(
        text: string,
        options: ScanOptions = {},
    ): Detection[] {
        if (options.mode === "context-free")
            return finishDetections(
                text,
                detectPatterns(text, false),
                exceptions,
            );
        const detections = detectPatterns(text, true);
        for (const [start, end] of detectAssignments(
            text,
            isSensitiveField,
            options.filePath,
        ))
            detections.push(fieldDetection(start, end));
        return finishDetections(text, detections, exceptions);
    }

    function namedValueDetections(name: string, value: string): Detection[] {
        const detections = detectPatterns(value, true);
        if (isSensitiveField(name))
            detections.push(fieldDetection(0, value.length));
        return finishDetections(value, detections, exceptions);
    }

    const redactor: Redactor = {
        config: normalized.config,
        isSensitiveField,
        scan: (text, options) => createTextScan(scanDetections(text, options)),
        redactText: (text, options) =>
            renderRange(text, scanDetections(text, options), 0, text.length),
        scanNamedValue: (name, value) =>
            createTextScan(namedValueDetections(name, value)),
        redactNamedValue: (name, value) =>
            renderRange(
                value,
                namedValueDetections(name, value),
                0,
                value.length,
            ),
        redactJson: (value, options) =>
            redactJsonValue(
                {
                    scanText: (text, isContextFree) =>
                        scanDetections(text, {
                            mode: isContextFree ? "context-free" : "full",
                        }),
                    scanNamedValue: namedValueDetections,
                    render: (text, detections) =>
                        renderRange(text, detections, 0, text.length),
                    isSensitiveField,
                },
                value,
                options,
            ),
    };
    return Object.freeze(redactor);
}
