import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Upper bound on the sidekick report the lead receives. The Devin CLI analysis records no sidekick report limit, so it is fixed here. */
export const SIDEKICK_REPORT_TOKEN_LIMIT = 131_072;
/** Pi's context estimate (`estimateTokens`) counts 4 characters per token, so the limit uses the same unit. */
const CHARS_PER_TOKEN = 4;
export const SIDEKICK_REPORT_CHAR_LIMIT = SIDEKICK_REPORT_TOKEN_LIMIT * CHARS_PER_TOKEN;

export interface BoundedReport {
  text: string;
  /** Private temporary file with the complete report, set only when the report was cut and the file was written. */
  fullReportPath?: string;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** Keeps the beginning of the report within `maxChars` without splitting a surrogate pair. */
export function truncateReport(text: string, maxChars = SIDEKICK_REPORT_CHAR_LIMIT): { text: string; isTruncated: boolean } {
  if (text.length <= maxChars) return { text, isTruncated: false };
  const end = isHighSurrogate(text.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars;
  return { text: text.slice(0, end), isTruncated: true };
}

/**
 * Bounds the report before it reaches the lead and keeps the complete text in a private temporary file.
 * Never rejects: background reports are delivered from a detached promise, so a failed write only changes the notice.
 */
export async function boundReport(text: string, maxChars = SIDEKICK_REPORT_CHAR_LIMIT): Promise<BoundedReport> {
  const result = truncateReport(text, maxChars);
  if (!result.isTruncated) return { text };
  const notice = `[The sidekick report exceeded about ${SIDEKICK_REPORT_TOKEN_LIMIT} tokens and was cut.`;
  try {
    const directory = await mkdtemp(join(tmpdir(), "pi-devin-sidekick-report-"));
    const fullReportPath = join(directory, "report.md");
    await writeFile(fullReportPath, text, { encoding: "utf8", mode: 0o600 });
    return { text: `${result.text}\n\n${notice} Full report: ${fullReportPath}]`, fullReportPath };
  } catch (error) {
    return { text: `${result.text}\n\n${notice} The full report could not be saved: ${error instanceof Error ? error.message : String(error)}]` };
  }
}
