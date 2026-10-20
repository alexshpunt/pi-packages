import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    canonicalJson,
    digest,
    immutable,
    type Json,
    type ReviewAssessment,
    type ReviewContext,
} from "../contracts.js";
import { isContentStructure } from "./redaction.js";

const CACHE_VERSION = 2;
const MAX_REVIEW_APPROVALS = 10_000;
const HOUR_MS = 60 * 60 * 1000;

function cachedAssessment(value: unknown): ReviewAssessment | undefined {
    if (typeof value !== "string") return;
    const assessment = JSON.parse(value) as ReviewAssessment;
    if (
        assessment?.outcome !== "allow" ||
        !["low", "medium", "high"].includes(assessment.risk_level) ||
        !["unknown", "low", "medium", "high"].includes(
            assessment.user_authorization,
        ) ||
        (assessment.risk_level === "high" &&
            !["medium", "high"].includes(assessment.user_authorization)) ||
        typeof assessment.rationale !== "string" ||
        assessment.rationale.length > 4000
    )
        return;
    return immutable(assessment);
}

/** SQLite is an optimization: storage errors fall back to a new review. */
export class ReviewApprovalCache {
    private database?: DatabaseSync;
    private isClosed = false;
    private readonly providers = new WeakMap<object, number>();
    private readonly instanceId = randomUUID();
    private nextProviderId = 0;

    constructor(
        readonly path = ":memory:",
        private readonly nowMs: () => number = Date.now,
    ) {}

    initialize(): void {
        this.connection();
    }

    private connection(): DatabaseSync | undefined {
        if (this.isClosed) return;
        if (this.database) return this.database;
        let database: DatabaseSync | undefined;
        try {
            if (this.path !== ":memory:") {
                mkdirSync(dirname(this.path), {
                    recursive: true,
                    mode: 0o700,
                });
                closeSync(openSync(this.path, "a", 0o600));
                chmodSync(this.path, 0o600);
            }
            database = new DatabaseSync(this.path, { timeout: 100 });
            const version = database.prepare("PRAGMA user_version").get();
            if (version?.user_version !== 0 && version?.user_version !== 1)
                throw new Error("Unsupported review cache schema");
            // Short transactions and a busy timeout share safely on supported SQLite versions.
            database.exec(`
                PRAGMA journal_mode = DELETE;
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS review_approvals (
                    cache_key TEXT PRIMARY KEY,
                    assessment_json TEXT NOT NULL,
                    approved_at_ms INTEGER NOT NULL,
                    expires_at_ms INTEGER NOT NULL,
                    CHECK (expires_at_ms > approved_at_ms)
                ) STRICT;
                CREATE INDEX IF NOT EXISTS review_approvals_expiry
                    ON review_approvals (expires_at_ms);
                PRAGMA user_version = 1;
                COMMIT;
            `);
            this.database = database;
            return database;
        } catch {
            database?.close();
            return;
        }
    }

    key(provider: object | string, input: unknown): string {
        let providerIdentity: string;
        if (typeof provider === "string") {
            providerIdentity = provider;
        } else {
            let providerId = this.providers.get(provider);
            if (providerId === undefined) {
                providerId = this.nextProviderId++;
                this.providers.set(provider, providerId);
            }
            // Anonymous custom providers cannot borrow another process's approval.
            providerIdentity = `${this.instanceId}:${providerId}`;
        }
        return digest({ version: CACHE_VERSION, providerIdentity, input });
    }

    get(key: string): ReviewAssessment | undefined {
        try {
            const row = this.connection()
                ?.prepare(
                    `SELECT assessment_json, approved_at_ms, expires_at_ms
                     FROM review_approvals WHERE cache_key = ?`,
                )
                .get(key);
            const nowMs = this.nowMs();
            if (
                !row ||
                typeof row.approved_at_ms !== "number" ||
                typeof row.expires_at_ms !== "number" ||
                row.approved_at_ms > nowMs ||
                row.expires_at_ms <= nowMs ||
                row.expires_at_ms > row.approved_at_ms + 12 * HOUR_MS
            )
                return;
            return cachedAssessment(row.assessment_json);
        } catch {
            return;
        }
    }

    remember(
        key: string,
        assessment: ReviewAssessment,
        ttlHours: number,
    ): void {
        if (
            assessment.outcome !== "allow" ||
            !Number.isInteger(ttlHours) ||
            ttlHours < 1 ||
            ttlHours > 12
        )
            return;
        try {
            const database = this.connection();
            if (!database) return;
            const approvedAtMs = this.nowMs();
            const expiresAtMs = approvedAtMs + ttlHours * HOUR_MS;
            database
                .prepare(
                    `INSERT INTO review_approvals
                         (cache_key, assessment_json, approved_at_ms, expires_at_ms)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(cache_key) DO UPDATE SET
                         assessment_json = excluded.assessment_json,
                         approved_at_ms = excluded.approved_at_ms,
                         expires_at_ms = excluded.expires_at_ms`,
                )
                .run(key, canonicalJson(assessment), approvedAtMs, expiresAtMs);
            database
                .prepare(
                    "DELETE FROM review_approvals WHERE expires_at_ms <= ?",
                )
                .run(approvedAtMs);
            database
                .prepare(
                    `DELETE FROM review_approvals WHERE cache_key IN (
                         SELECT cache_key FROM review_approvals
                         ORDER BY approved_at_ms DESC, cache_key DESC
                         LIMIT -1 OFFSET ?
                     )`,
                )
                .run(MAX_REVIEW_APPROVALS);
        } catch {
            // A failed write or cleanup never changes the completed approval.
        }
    }

    close(): void {
        this.database?.close();
        this.database = undefined;
        this.isClosed = true;
    }
}

/** Preserve content, trust, chronology and reference relationships without session-specific IDs. */
export function reviewCacheContext(
    context: Omit<ReviewContext, "digest">,
): Json {
    const references = new Map<string, string>();
    const reference = (value: string) => {
        let identity = references.get(value);
        if (identity === undefined) {
            identity = `reference-${references.size}`;
            references.set(value, identity);
        }
        return identity;
    };
    const normalize = (value: Json, path: (string | number)[]): Json => {
        if (
            typeof value === "string" &&
            isContentStructure(path) &&
            [
                "toolCallId",
                "callIdentity",
                "parentToolCallId",
                "parentCallIdentity",
                "actionDigest",
                "contextDigest",
            ].includes(String(path.at(-1)))
        )
            return reference(value);
        if (Array.isArray(value))
            return value.map((item, i) => normalize(item, [...path, i]));
        if (!value || typeof value !== "object") return value;
        const isToolCall =
            path.length === 2 &&
            path[0] === "content" &&
            typeof path[1] === "number" &&
            value.type === "toolCall";
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [
                    key,
                    isToolCall && key === "id" && typeof value[key] === "string"
                        ? reference(value[key])
                        : normalize(value[key], [...path, key]),
                ]),
        );
    };
    return context.items.map((item) => ({
        source: item.source,
        trust: item.trust,
        isTruncated: item.isTruncated ?? false,
        content:
            item.trust === "evidence"
                ? normalize(item.content, [])
                : item.content,
    }));
}
