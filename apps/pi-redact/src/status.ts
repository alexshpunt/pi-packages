import { REDACTION_MARKER } from "./render.js";

export interface SessionStats {
  toolResults: number;
  requests: number;
  summaries: number;
  blockedCalls: number;
  withheld: number;
}

export const emptyStats = (): SessionStats => ({
  toolResults: 0,
  requests: 0,
  summaries: 0,
  blockedCalls: 0,
  withheld: 0,
});

/** Saved analytics records, or why they could not be counted. */
export type AnalyticsCounts = { readonly session: number; readonly all: number } | { readonly error: string };

/** A snapshot of what `/redact` shows. */
export interface RedactStatus {
  /** Whether masking applies in this session right now. */
  readonly isEnabled: boolean;
  /** This session's own choice; `undefined` when it follows the global default. */
  readonly sessionChoice: boolean | undefined;
  readonly isEnabledByDefault: boolean;
  readonly globalSettingsPath: string;
  readonly sources: readonly string[];
  readonly problems: readonly string[];
  readonly disabledRules: readonly string[];
  readonly stats: SessionStats;
  readonly analytics: AnalyticsCounts;
}

export const onOff = (isEnabled: boolean) => (isEnabled ? "on" : "off");

export function maskingLine(status: RedactStatus): string {
  const source =
    status.sessionChoice === undefined
      ? "this session follows the global default"
      : `set for this session; the global default is ${onOff(status.isEnabledByDefault)}`;
  return `Masking is ${onOff(status.isEnabled)} (${source}).`;
}

/** Plain-text status, used by the page and when Pi has no terminal UI. */
export function statusLines(status: RedactStatus): string[] {
  const { stats, analytics } = status;
  const lines = [maskingLine(status)];
  if (!status.isEnabled)
    lines.push(
      `While masking is off, tool results are stored and sent unmasked. Writing ${REDACTION_MARKER} is still blocked.`,
    );
  lines.push(`Settings: ${status.sources.length ? status.sources.join(", ") : "built-in rules only"}`);
  if (status.disabledRules.length) lines.push(`Built-in rules turned off: ${status.disabledRules.join(", ")}`);
  lines.push(...status.problems.map((problem) => `Skipped: ${problem}`));
  lines.push(
    `This session: ${stats.toolResults} tool results masked, ${stats.requests} model requests changed, ` +
      `${stats.summaries} summaries checked, ${stats.blockedCalls} calls blocked, ${stats.withheld} items withheld.`,
  );
  lines.push(
    "error" in analytics
      ? `Analytics: ${analytics.error}`
      : `Analytics: ${analytics.session} records in this session, ${analytics.all} in the last 30 days.`,
  );
  return lines;
}
