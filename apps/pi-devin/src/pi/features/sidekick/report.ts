import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import type { DevinError } from "../../../core/errors.ts";
import { fromPlatformError } from "../../../core/services/platform.ts";
import type { BoundedReport } from "./types.ts";

/** Upper bound on the sidekick report the lead receives. The Devin CLI analysis records no sidekick report limit, so it is fixed here. */
export const SIDEKICK_REPORT_TOKEN_LIMIT = 131_072;
/** Pi's context estimate (`estimateTokens`) counts 4 characters per token, so the limit uses the same unit. */
const CHARS_PER_TOKEN = 4;
export const SIDEKICK_REPORT_CHAR_LIMIT = SIDEKICK_REPORT_TOKEN_LIMIT * CHARS_PER_TOKEN;


const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** Keeps the beginning of the report within `maxChars` without splitting a surrogate pair. */
export function truncateReport(text: string, maxChars = SIDEKICK_REPORT_CHAR_LIMIT): { text: string; isTruncated: boolean } {
  if (text.length <= maxChars) return { text, isTruncated: false };
  const end = isHighSurrogate(text.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars;
  return { text: text.slice(0, end), isTruncated: true };
}

/** Writes the complete report to a new private temporary directory and returns the file path. */
function preserveReport(text: string): Effect.Effect<string, DevinError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectory({ prefix: "pi-devin-sidekick-report-" });
    const path = join(directory, "report.md");
    yield* fs.writeFileString(path, text, { mode: 0o600 });
    return path;
  }).pipe(Effect.mapError(fromPlatformError));
}

/**
 * Bounds the report before it reaches the lead and keeps the complete text in a private temporary file.
 * Never fails: background reports are delivered from a detached fiber, so a failed write only changes the notice.
 */
export function boundReport(text: string, maxChars = SIDEKICK_REPORT_CHAR_LIMIT): Effect.Effect<BoundedReport, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const result = truncateReport(text, maxChars);
    if (!result.isTruncated) return { text };
    const saved = yield* Effect.result(preserveReport(text));
    const fullReportPath = saved._tag === "Success" ? saved.success : undefined;
    const notice = `\n\n[The sidekick report exceeded about ${SIDEKICK_REPORT_TOKEN_LIMIT} tokens and was cut.` + (saved._tag === "Success"
      ? ` Full report: ${saved.success}]`
      : ` The full report could not be saved: ${saved.failure.message}]`);
    // The notice is part of the same budget, including a filesystem error if preservation failed.
    const suffix = truncateReport(notice, maxChars).text;
    return { text: truncateReport(text, maxChars - suffix.length).text + suffix, ...(fullReportPath ? { fullReportPath } : {}) };
  });
}
