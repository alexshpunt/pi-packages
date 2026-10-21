import type { Detection, Redactor } from "@buyong/redact";
import type { TextCache } from "./cache.js";
import { findLineDecoration } from "./decorations.js";
import { renderMarked, type TextRange } from "./render.js";

/**
 * Masking with the extension's marker. Every method returns its input itself when nothing
 * was detected, so callers detect changes by identity and copy only what changed.
 */
export interface MaskEngine {
  readonly redactor: Redactor;
  maskText(text: string, filePath?: string): string;
  /** Copy of a JSON-compatible value with masked strings; keys and non-string scalars stay. */
  maskJson<T>(value: T): T;
}

function addDetections(ranges: TextRange[], detections: readonly Detection[], offset: number): void {
  for (const { start, end } of detections) ranges.push([start + offset, end + offset]);
}

/** Pass `cache` only for text that is masked repeatedly, such as every model request. */
export function createMaskEngine(redactor: Redactor, cache?: TextCache): MaskEngine {
  function scanOptions(filePath: string | undefined) {
    return filePath === undefined ? undefined : { filePath };
  }

  function textRanges(text: string, filePath: string | undefined): TextRange[] {
    const ranges: TextRange[] = [];
    addDetections(ranges, redactor.scan(text, scanOptions(filePath)).detections, 0);
    for (let lineStart = 0; lineStart < text.length; ) {
      const newline = text.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? text.length : newline;
      const decoration = findLineDecoration(text, lineStart, lineEnd);
      if (decoration) {
        const content = text.slice(decoration.contentStart, lineEnd);
        const hint = decoration.filePath ?? filePath;
        addDetections(ranges, redactor.scan(content, scanOptions(hint)).detections, decoration.contentStart);
      }
      lineStart = lineEnd + 1;
    }
    return ranges;
  }

  function maskText(text: string, filePath?: string): string {
    if (text.length === 0) return text;
    const cached = cache?.get(text, filePath);
    if (cached !== undefined) return cached;
    const result = renderMarked(text, textRanges(text, filePath));
    cache?.set(text, filePath, result);
    return result;
  }

  function maskNamedValue(name: string, value: string): string {
    if (value.length === 0) return value;
    const ranges: TextRange[] = [];
    addDetections(ranges, redactor.scanNamedValue(name, value).detections, 0);
    return renderMarked(value, ranges);
  }

  function maskJsonValue(value: unknown, fieldName: string | undefined, visiting: Set<object>): unknown {
    if (typeof value === "string")
      return fieldName !== undefined && redactor.isSensitiveField(fieldName)
        ? maskNamedValue(fieldName, value)
        : maskText(value);
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

  return Object.freeze({
    redactor,
    maskText,
    maskJson: <T>(value: T): T => maskJsonValue(value, undefined, new Set()) as T,
  });
}
