// Key-preserving JSON masking, generalized from codemap-search `src/redact/response.rs`.

import type { Detection } from "./detection.js";
import { hideValue, type TextRange } from "./transform.js";

export type JsonPathSegment = string | number;

/** Where masking changed a string: its JSON path and the rule that matched. Never the value. */
export interface MaskedLocation {
    readonly path: readonly JsonPathSegment[];
    readonly ruleId: string;
}

export interface RedactJsonOptions {
    /**
     * `whole` (default) scans each string at once so multi-line blocks such as
     * PEM keys and YAML block scalars are found; `line` scans each line alone
     * so unrelated metadata lines cannot share a quote or block continuation.
     */
    readonly stringScope?: "whole" | "line";
    /**
     * `context-free` re-applies only context-free rules to `text` in objects
     * whose `type` is `"text"`, for content already rendered from a scanned
     * original. The default `full` scans it like any other string.
     */
    readonly textContent?: "full" | "context-free";
    /** Values at paths for which this returns true are copied unchanged, including subtrees. */
    readonly shouldPreserve?: (path: readonly JsonPathSegment[]) => boolean;
}

export interface RedactJsonResult<T> {
    readonly value: T;
    readonly maskedLocations: readonly MaskedLocation[];
}

export interface StringScanner {
    scanText(text: string, isContextFree: boolean): readonly Detection[];
    scanNamedValue(name: string, value: string): readonly Detection[];
    render(text: string, detections: readonly Detection[]): string;
    isSensitiveField(name: string): boolean;
}

function changedRuleIds(
    text: string,
    detections: readonly Detection[],
): string[] {
    return detections
        .filter(({ start, end }) => {
            const original = text.slice(start, end);
            return hideValue(original) !== original;
        })
        .map((detection) => detection.ruleId);
}

function lineRanges(text: string): TextRange[] {
    const ranges: TextRange[] = [];
    for (let start = 0; start < text.length; ) {
        const newline = text.indexOf("\n", start);
        const end = newline === -1 ? text.length : newline + 1;
        ranges.push([start, end]);
        start = end;
    }
    return ranges;
}

export function redactJsonValue<T>(
    scanner: StringScanner,
    input: T,
    options: RedactJsonOptions = {},
): RedactJsonResult<T> {
    const isLineScoped = options.stringScope === "line";
    const isTextContentContextFree = options.textContent === "context-free";
    const shouldPreserve = options.shouldPreserve ?? (() => false);
    const maskedLocations: MaskedLocation[] = [];
    const recorded = new Set<string>();

    function record(path: readonly JsonPathSegment[], ruleIds: string[]) {
        for (const ruleId of ruleIds) {
            const key = `${JSON.stringify(path)}\u0000${ruleId}`;
            if (recorded.has(key)) continue;
            recorded.add(key);
            maskedLocations.push(
                Object.freeze({ path: Object.freeze([...path]), ruleId }),
            );
        }
    }

    function maskDetections(
        path: readonly JsonPathSegment[],
        text: string,
        detections: readonly Detection[],
    ): string {
        record(path, changedRuleIds(text, detections));
        return scanner.render(text, detections);
    }

    function maskString(
        path: readonly JsonPathSegment[],
        text: string,
        fieldName: string | undefined,
        isTextContent: boolean,
    ): string {
        if (fieldName !== undefined && scanner.isSensitiveField(fieldName))
            return maskDetections(
                path,
                text,
                scanner.scanNamedValue(fieldName, text),
            );
        if (isTextContent && isTextContentContextFree)
            return maskDetections(path, text, scanner.scanText(text, true));
        if (!isLineScoped)
            return maskDetections(path, text, scanner.scanText(text, false));
        return lineRanges(text)
            .map(([start, end]) =>
                maskDetections(
                    path,
                    text.slice(start, end),
                    scanner.scanText(text.slice(start, end), false),
                ),
            )
            .join("");
    }

    function walk(
        value: unknown,
        path: readonly JsonPathSegment[],
        fieldName?: string,
        isTextContent = false,
    ): unknown {
        if (shouldPreserve(path)) return value;
        if (typeof value === "string")
            return maskString(path, value, fieldName, isTextContent);
        if (Array.isArray(value))
            return value.map((item, index) => walk(item, [...path, index]));
        if (typeof value !== "object" || value === null) return value;
        const toJSON = (value as { toJSON?: unknown }).toJSON;
        if (typeof toJSON === "function") {
            const serialized: unknown = toJSON.call(value, fieldName ?? "");
            if (serialized !== value)
                return walk(serialized, path, fieldName, isTextContent);
        }
        const fields = value as Record<string, unknown>;
        const isTextObject = fields.type === "text";
        // Object.fromEntries defines own properties, so a "__proto__" key stays data.
        return Object.fromEntries(
            Object.entries(fields).map(([key, item]) => [
                key,
                walk(item, [...path, key], key, isTextObject && key === "text"),
            ]),
        );
    }

    const value = walk(input, []) as T;
    return { value, maskedLocations: Object.freeze(maskedLocations) };
}
