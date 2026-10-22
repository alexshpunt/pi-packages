import type { Detection, Redactor } from "@buyong/redact";
import type { TextCache } from "./cache.js";
import { findLineDecoration } from "./decorations.js";
import { renderMarked, type TextRange } from "./render.js";

/** One string that masking changed, reported to the engine's observer. */
export interface MaskObservation {
  /** What was masked, as set by the innermost `labeled()` call. */
  readonly label: string;
  readonly before: string;
  readonly after: string;
  /** Ids of the rules whose detections were masked, in first-seen order. */
  readonly ruleIds: readonly string[];
  readonly filePath?: string;
  /** JSON field that held the string, when it came from a JSON value. */
  readonly fieldName?: string;
}

export interface MaskEngineOptions {
  /** Rule ids whose detections are ignored. */
  readonly disabledRules?: Iterable<string>;
  /** Called for every string masking changed; a cached result is not reported again. */
  readonly observe?: (observation: MaskObservation) => void;
}

/**
 * Masking with the extension's marker. Every method returns its input itself when nothing
 * was detected, so callers detect changes by identity and copy only what changed.
 */
export interface MaskEngine {
  readonly redactor: Redactor;
  maskText(text: string, filePath?: string): string;
  /** Copy of a JSON-compatible value with masked strings; keys and non-string scalars stay. */
  maskJson<T>(value: T): T;
  /** Run `mask` with `label` naming what it masks, for the observer. */
  labeled<T>(label: string, mask: () => T): T;
}

const DEFAULT_LABEL = "text";

interface Collected {
  readonly ranges: TextRange[];
  readonly ruleIds: Set<string>;
}

/** Pass `cache` only for text that is masked repeatedly, such as every model request. */
export function createMaskEngine(redactor: Redactor, cache?: TextCache, options: MaskEngineOptions = {}): MaskEngine {
  const disabled = new Set(options.disabledRules ?? []);
  const { observe } = options;
  let currentLabel = DEFAULT_LABEL;

  function scanOptions(filePath: string | undefined) {
    return filePath === undefined ? undefined : { filePath };
  }

  function addDetections(collected: Collected, detections: readonly Detection[], offset: number): void {
    for (const { start, end, ruleId } of detections) {
      if (disabled.has(ruleId)) continue;
      collected.ranges.push([start + offset, end + offset]);
      collected.ruleIds.add(ruleId);
    }
  }

  function textRanges(text: string, filePath: string | undefined): Collected {
    const collected: Collected = { ranges: [], ruleIds: new Set() };
    addDetections(collected, redactor.scan(text, scanOptions(filePath)).detections, 0);
    for (let lineStart = 0; lineStart < text.length; ) {
      const newline = text.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? text.length : newline;
      const decoration = findLineDecoration(text, lineStart, lineEnd);
      if (decoration) {
        const content = text.slice(decoration.contentStart, lineEnd);
        const hint = decoration.filePath ?? filePath;
        addDetections(collected, redactor.scan(content, scanOptions(hint)).detections, decoration.contentStart);
      }
      lineStart = lineEnd + 1;
    }
    return collected;
  }

  function report(before: string, after: string, collected: Collected, filePath?: string, fieldName?: string): void {
    if (!observe || after === before) return;
    observe({
      label: currentLabel,
      before,
      after,
      ruleIds: [...collected.ruleIds],
      ...(filePath === undefined ? {} : { filePath }),
      ...(fieldName === undefined ? {} : { fieldName }),
    });
  }

  function maskTextIn(text: string, filePath: string | undefined, fieldName: string | undefined): string {
    if (text.length === 0) return text;
    const cached = cache?.get(text, filePath);
    if (cached !== undefined) return cached;
    const collected = textRanges(text, filePath);
    const result = renderMarked(text, collected.ranges);
    cache?.set(text, filePath, result);
    report(text, result, collected, filePath, fieldName);
    return result;
  }

  function maskNamedValue(name: string, value: string): string {
    if (value.length === 0) return value;
    const collected: Collected = { ranges: [], ruleIds: new Set() };
    addDetections(collected, redactor.scanNamedValue(name, value).detections, 0);
    const result = renderMarked(value, collected.ranges);
    report(value, result, collected, undefined, name);
    return result;
  }

  function maskJsonValue(value: unknown, fieldName: string | undefined, visiting: Set<object>): unknown {
    if (typeof value === "string")
      return fieldName !== undefined && redactor.isSensitiveField(fieldName)
        ? maskNamedValue(fieldName, value)
        : maskTextIn(value, undefined, fieldName);
    if (typeof value !== "object" || value === null || visiting.has(value)) return value;
    visiting.add(value);
    try {
      if (Array.isArray(value)) {
        let copy: unknown[] | undefined;
        value.forEach((item: unknown, index) => {
          // Array items do not inherit the sensitivity of the key that holds the array.
          const masked = maskJsonValue(item, undefined, visiting);
          if (masked === item) return;
          copy ??= [...value];
          copy[index] = masked;
        });
        return copy ?? value;
      }
      const toJSON = (value as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") {
        const serialized: unknown = toJSON.call(value, fieldName ?? "");
        if (serialized !== value) {
          const masked = maskJsonValue(serialized, fieldName, visiting);
          return masked === serialized ? value : masked;
        }
      }
      const fields = value as Record<string, unknown>;
      const keys = Object.keys(fields);
      let entries: [string, unknown][] | undefined;
      keys.forEach((key, index) => {
        const item = fields[key];
        const masked = maskJsonValue(item, key, visiting);
        if (masked === item) return;
        entries ??= keys.map((name): [string, unknown] => [name, fields[name]]);
        entries[index] = [key, masked];
      });
      // Object.fromEntries defines own properties, so a "__proto__" key stays data.
      return entries ? Object.fromEntries(entries) : value;
    } finally {
      visiting.delete(value);
    }
  }

  function labeled<T>(label: string, mask: () => T): T {
    if (!observe) return mask();
    const previous = currentLabel;
    currentLabel = label;
    try {
      return mask();
    } finally {
      currentLabel = previous;
    }
  }

  return Object.freeze({
    redactor,
    maskText: (text: string, filePath?: string) => maskTextIn(text, filePath, undefined),
    maskJson: <T>(value: T): T => maskJsonValue(value, undefined, new Set()) as T,
    labeled,
  });
}
