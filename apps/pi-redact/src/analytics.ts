import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildExcerpt, decodeExcerpt, type Excerpt, encodeExcerpt } from "./excerpt.js";
import { SETTINGS_DIRECTORY } from "./settings.js";

/** Records older than this are deleted. Fixed: the store holds the original values. */
export const ANALYTICS_RETENTION_DAYS = 30;
/** The newest records kept, whatever their age, so a busy month cannot grow the file without bound. */
export const MAX_ANALYTICS_RECORDS = 50_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = ANALYTICS_RETENTION_DAYS * DAY_MS;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
/** How long a statement waits for another Pi process's write; masking must not stall behind analytics. */
const BUSY_TIMEOUT_MS = 250;
const SCHEMA_VERSION = 1;

export function analyticsPath(agentDir: string): string {
  return join(agentDir, SETTINGS_DIRECTORY, "analytics.sqlite");
}

/** Which pi-redact step masked the text. */
export type RedactionSource = "tool result" | "model request" | "compaction" | "branch summary";

/** A masked string as the extension observed it. */
export interface RedactionEvent {
  readonly source: RedactionSource;
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly ruleIds: readonly string[];
}

export interface RecordSummary {
  readonly id: number;
  readonly recordedAtMs: number;
  readonly sessionId: string;
  readonly cwd: string;
  readonly source: RedactionSource;
  readonly label: string;
  readonly ruleIds: readonly string[];
  readonly changedLines: number;
}

export interface StoredRecord extends RecordSummary {
  /** `undefined` when the stored excerpt cannot be read. */
  readonly excerpt: Excerpt | undefined;
}

/** Records of one session, or of every session when `sessionId` is absent. */
export interface AnalyticsScope {
  readonly sessionId?: string;
}

export interface AnalyticsSummary {
  readonly records: number;
  readonly changedLines: number;
  /** Records per rule id, most frequent first. */
  readonly rules: readonly (readonly [ruleId: string, records: number])[];
}

/** UI-facing record operations; the session adapter supplies their synchronous boundary. */
export interface AnalyticsReader {
  list(scope: AnalyticsScope, limit: number): readonly RecordSummary[];
  summarize(scope: AnalyticsScope): AnalyticsSummary;
  get(id: number): StoredRecord | undefined;
  clear(scope: AnalyticsScope): number;
}

const SOURCES: readonly RedactionSource[] = ["tool result", "model request", "compaction", "branch summary"];

/**
 * Identity of a masking within a session. The label is left out: a `read` result carries the same
 * text in `content` and `structuredContent`, and each request repeats the same messages.
 */
function fingerprint(event: RedactionEvent): string {
  return createHash("sha256").update([event.source, event.before, event.after].join("\u0000")).digest("hex");
}

function parseRuleIds(value: unknown): string[] {
  return typeof value === "string" && value ? value.split(",") : [];
}

function summaryOf(row: Record<string, unknown>): RecordSummary | undefined {
  const source = row.source as RedactionSource;
  if (
    typeof row.id !== "number" ||
    typeof row.recorded_at_ms !== "number" ||
    typeof row.session_id !== "string" ||
    typeof row.cwd !== "string" ||
    !SOURCES.includes(source) ||
    typeof row.label !== "string" ||
    typeof row.changed_lines !== "number"
  )
    return undefined;
  return {
    id: row.id,
    recordedAtMs: row.recorded_at_ms,
    sessionId: row.session_id,
    cwd: row.cwd,
    source,
    label: row.label,
    ruleIds: parseRuleIds(row.rule_ids),
    changedLines: row.changed_lines,
  };
}

/**
 * Before-and-after excerpts of masked text for `/redact-analytics`, shared by every Pi
 * process that uses the same agent directory. The file holds original values, so it is
 * created readable only by the user and records expire after `ANALYTICS_RETENTION_DAYS`.
 * Methods throw on storage errors; callers decide how to report them.
 */
export class AnalyticsStore {
  #database: DatabaseSync | undefined;
  #isClosed = false;
  #lastPurgeMs = Number.NEGATIVE_INFINITY;

  constructor(
    readonly path: string,
    private readonly nowMs: () => number = Date.now,
  ) {}

  #connection(): DatabaseSync {
    if (this.#isClosed) throw new Error("The analytics store is closed.");
    if (this.#database) return this.#database;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    closeSync(openSync(this.path, "a", 0o600));
    chmodSync(this.path, 0o600);
    const database = new DatabaseSync(this.path, { timeout: BUSY_TIMEOUT_MS });
    try {
      const version = database.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== SCHEMA_VERSION) throw new Error("The analytics file has an unknown format.");
      database.exec(`
        PRAGMA journal_mode = DELETE;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS redaction_records (
          id INTEGER PRIMARY KEY,
          recorded_at_ms INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          source TEXT NOT NULL,
          label TEXT NOT NULL,
          rule_ids TEXT NOT NULL,
          changed_lines INTEGER NOT NULL,
          excerpt_json TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          UNIQUE (session_id, fingerprint)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS redaction_records_time ON redaction_records (recorded_at_ms);
        CREATE INDEX IF NOT EXISTS redaction_records_session ON redaction_records (session_id, recorded_at_ms);
        PRAGMA user_version = ${SCHEMA_VERSION};
        COMMIT;
      `);
    } catch (error) {
      database.close();
      throw error;
    }
    this.#database = database;
    return database;
  }

  /** Delete expired records and those beyond the record limit, at most once an hour per process. */
  #purge(database: DatabaseSync): void {
    const nowMs = this.nowMs();
    if (nowMs - this.#lastPurgeMs < PURGE_INTERVAL_MS) return;
    database.prepare("DELETE FROM redaction_records WHERE recorded_at_ms < ?").run(nowMs - RETENTION_MS);
    database
      .prepare(
        `DELETE FROM redaction_records WHERE id IN (
           SELECT id FROM redaction_records ORDER BY recorded_at_ms DESC, id DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(MAX_ANALYTICS_RECORDS);
    this.#lastPurgeMs = nowMs;
  }

  #cutoffMs(): number {
    return this.nowMs() - RETENTION_MS;
  }

  /** Store events of one session; the same text masked the same way is stored once per session and step. Returns how many were added. */
  record(context: { readonly sessionId: string; readonly cwd: string }, events: readonly RedactionEvent[]): number {
    if (events.length === 0) return 0;
    const database = this.#connection();
    const recordedAtMs = this.nowMs();
    const insert = database.prepare(
      `INSERT OR IGNORE INTO redaction_records
         (recorded_at_ms, session_id, cwd, source, label, rule_ids, changed_lines, excerpt_json, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        const excerpt = buildExcerpt(event.before, event.after);
        const result = insert.run(
          recordedAtMs,
          context.sessionId,
          context.cwd,
          event.source,
          event.label,
          event.ruleIds.join(","),
          excerpt.changedLines,
          encodeExcerpt(excerpt),
          fingerprint(event),
        );
        added += Number(result.changes);
      }
      this.#purge(database);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return added;
  }

  /** Newest first, without excerpts. */
  list(scope: AnalyticsScope, limit: number): RecordSummary[] {
    const database = this.#connection();
    this.#purge(database);
    const columns = "id, recorded_at_ms, session_id, cwd, source, label, rule_ids, changed_lines";
    const rows =
      scope.sessionId === undefined
        ? database
            .prepare(
              `SELECT ${columns} FROM redaction_records WHERE recorded_at_ms >= ?
               ORDER BY recorded_at_ms DESC, id DESC LIMIT ?`,
            )
            .all(this.#cutoffMs(), limit)
        : database
            .prepare(
              `SELECT ${columns} FROM redaction_records WHERE session_id = ? AND recorded_at_ms >= ?
               ORDER BY recorded_at_ms DESC, id DESC LIMIT ?`,
            )
            .all(scope.sessionId, this.#cutoffMs(), limit);
    return rows.flatMap((row) => summaryOf(row as Record<string, unknown>) ?? []);
  }

  get(id: number): StoredRecord | undefined {
    const row = this.#connection()
      .prepare(
        `SELECT id, recorded_at_ms, session_id, cwd, source, label, rule_ids, changed_lines, excerpt_json
         FROM redaction_records WHERE id = ? AND recorded_at_ms >= ?`,
      )
      .get(id, this.#cutoffMs()) as Record<string, unknown> | undefined;
    const summary = row && summaryOf(row);
    if (!summary) return undefined;
    return { ...summary, excerpt: typeof row.excerpt_json === "string" ? decodeExcerpt(row.excerpt_json) : undefined };
  }

  summarize(scope: AnalyticsScope): AnalyticsSummary {
    const database = this.#connection();
    const rows =
      scope.sessionId === undefined
        ? database
            .prepare("SELECT rule_ids, changed_lines FROM redaction_records WHERE recorded_at_ms >= ?")
            .all(this.#cutoffMs())
        : database
            .prepare(
              "SELECT rule_ids, changed_lines FROM redaction_records WHERE session_id = ? AND recorded_at_ms >= ?",
            )
            .all(scope.sessionId, this.#cutoffMs());
    const rules = new Map<string, number>();
    let changedLines = 0;
    for (const row of rows) {
      changedLines += Number(row.changed_lines) || 0;
      for (const ruleId of parseRuleIds(row.rule_ids)) rules.set(ruleId, (rules.get(ruleId) ?? 0) + 1);
    }
    return {
      records: rows.length,
      changedLines,
      rules: [...rules].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1)),
    };
  }

  count(scope: AnalyticsScope): number {
    const database = this.#connection();
    const row =
      scope.sessionId === undefined
        ? database
            .prepare("SELECT COUNT(*) AS n FROM redaction_records WHERE recorded_at_ms >= ?")
            .get(this.#cutoffMs())
        : database
            .prepare("SELECT COUNT(*) AS n FROM redaction_records WHERE session_id = ? AND recorded_at_ms >= ?")
            .get(scope.sessionId, this.#cutoffMs());
    return Number(row?.n) || 0;
  }

  /** Delete the records in `scope`; returns how many were deleted. */
  clear(scope: AnalyticsScope): number {
    const database = this.#connection();
    const result =
      scope.sessionId === undefined
        ? database.prepare("DELETE FROM redaction_records").run()
        : database.prepare("DELETE FROM redaction_records WHERE session_id = ?").run(scope.sessionId);
    return Number(result.changes);
  }

  /** Idempotent; later calls throw instead of reopening the file. */
  close(): void {
    this.#database?.close();
    this.#database = undefined;
    this.#isClosed = true;
  }
}
