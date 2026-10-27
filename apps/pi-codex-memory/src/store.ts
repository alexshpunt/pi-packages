import { randomUUID } from "node:crypto";
import {
    closeSync,
    existsSync,
    lstatSync,
    openSync,
    unlinkSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    DEFAULT_SETTINGS,
    type MemorySettings,
    parseSettings,
} from "./config.js";
import {
    MemoryFailure,
    type MemoryFailureCode,
    type MemoryUsage,
    MemoryUserError,
} from "./failure.js";
import {
    defaultMemoryScope,
    findRepository,
    type RegisteredRepository,
    type RepositoryLocation,
    type RepositoryObservation,
    repositoryScope,
} from "./repositories.js";
import {
    atomicWrite,
    canonicalCwd,
    createMemoryMasker,
    digest,
    privateDirectory,
    SUMMARY_MAX_BYTES,
    truncateMiddleBytes,
    workspaceScope,
} from "./safety.js";

export interface RolloutSource {
    id: string;
    cwd: string;
    file: string;
    leafId: string | null;
    updatedAtMs: number;
    fingerprint: string;
    text: string;
    repository?: RepositoryObservation;
}
export interface MemoryRecord {
    id: string;
    path: string;
    kind: "rollout" | "note";
    body: string;
    source: Omit<RolloutSource, "text"> | null;
    generatedAtMs: number;
    lastUsedAtMs: number;
    usageCount: number;
    truncatedBytes?: number;
    wasNormalized?: boolean;
    isPinned: boolean;
    expiresAtMs: number | null;
    importedFrom?: {
        scope: string;
        cwd: string;
        path: string;
        importedAtMs: number;
    };
}
export interface ScopeState {
    revision: number;
    generation: number;
    summary: string;
    consolidatedAtMs: number;
    inputs: Record<string, string>;
}
export interface JobLease {
    scope: string;
    key: string;
    owner: string;
    /** The scope's lease epoch at claim time; a later epoch voids the lease. */
    epoch: number;
    fingerprint: string;
}
/** How long an open session's heartbeat, and a coordinator's lease, last without renewal. */
export const ACTIVITY_TTL_MS = 90_000;
interface JobRow {
    owner: string | null;
    lease_until: number;
    retry_at: number;
    attempts: number;
    status: string;
    fingerprint: string;
}

function canClaim(
    row: JobRow | undefined,
    fingerprint: string,
    nowMs: number,
    settings: MemorySettings,
    force: boolean,
): boolean {
    if (row?.owner && row.lease_until > nowMs) return false;
    if (row?.fingerprint !== fingerprint) return true;
    if (row.status === "succeeded") return false;
    return (
        force || (row.retry_at <= nowMs && row.attempts < settings.maxAttempts)
    );
}
/** SQLite is authoritative; Markdown is a private, disposable projection. */
export class MemoryStore {
    private readonly database: DatabaseSync;
    private readonly mask = createMemoryMasker();
    private isClosed = false;
    constructor(readonly root: string) {
        privateDirectory(root);
        const path = join(root, "state.sqlite");
        if (!existsSync(path)) {
            try {
                closeSync(openSync(path, "wx", 0o600));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                    throw error;
            }
        }
        if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())
            throw new Error("Memory database must be a regular file.");
        this.database = new DatabaseSync(path);
        this.database.exec(`
            PRAGMA busy_timeout = 1000;
            PRAGMA journal_mode = DELETE;
            PRAGMA secure_delete = ON;
            CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
            INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
            CREATE TABLE IF NOT EXISTS scopes (
                scope TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
                generation INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '',
                consolidated_at INTEGER NOT NULL DEFAULT 0, inputs TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS settings (scope TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS selections (cwd TEXT PRIMARY KEY, scope TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS records (scope TEXT NOT NULL, id TEXT NOT NULL,
                path TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope, id), UNIQUE(scope, path));
            CREATE TABLE IF NOT EXISTS artifact_paths (scope TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(scope, path));
            CREATE TABLE IF NOT EXISTS tombstones (scope TEXT NOT NULL, source_id TEXT NOT NULL,
                PRIMARY KEY(scope, source_id));
            CREATE TABLE IF NOT EXISTS jobs (scope TEXT NOT NULL, key TEXT NOT NULL,
                fingerprint TEXT NOT NULL, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
                retry_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL, finished_at INTEGER NOT NULL DEFAULT 0,
                error TEXT NOT NULL DEFAULT '', PRIMARY KEY(scope, key));
            CREATE TABLE IF NOT EXISTS usage (scope TEXT NOT NULL, day TEXT NOT NULL,
                calls INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
                PRIMARY KEY(scope, day));
            CREATE TABLE IF NOT EXISTS activity (scope TEXT NOT NULL, session_id TEXT NOT NULL,
                owner TEXT NOT NULL, busy INTEGER NOT NULL, expires_at INTEGER NOT NULL,
                PRIMARY KEY(scope, session_id, owner));
        `);
        const version = this.database
            .prepare("SELECT version FROM schema_version")
            .get() as { version: number };
        if (version.version !== 1) {
            this.close();
            throw new Error("Unsupported memory database version.");
        }
        this.database.exec(`
            CREATE TABLE IF NOT EXISTS repositories (scope TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS coordinators (scope TEXT PRIMARY KEY, owner TEXT NOT NULL,
                lease_until INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS epochs (scope TEXT PRIMARY KEY, value INTEGER NOT NULL,
                changed_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS repository_reads (source_scope TEXT NOT NULL, target_scope TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(source_scope, target_scope));
        `);
    }
    close(): void {
        if (!this.isClosed) {
            this.isClosed = true;
            this.database.close();
        }
    }
    private transaction<T>(run: () => T): T {
        this.database.exec("BEGIN IMMEDIATE");
        try {
            const result = run();
            this.database.exec("COMMIT");
            return result;
        } catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
    }
    private ensureScope(scope: string): void {
        if (!/^(global|(?:workspace|repository)-[a-f0-9]{24})$/.test(scope))
            throw new Error("Invalid memory scope.");
        this.database
            .prepare("INSERT OR IGNORE INTO scopes(scope) VALUES (?)")
            .run(scope);
    }
    scopeFor(cwd: string): string {
        // Old cwd records/settings are preserved; only an explicit global choice
        // overrides the new default. No migration occurs while resolving a scope.
        return this.selectsGlobal(cwd) ? "global" : defaultMemoryScope(cwd);
    }
    /** Other scopes stop collecting new conversations from a cwd that explicitly selects personal global. */
    selectsGlobal(cwd: string): boolean {
        const selected = this.database
            .prepare("SELECT scope FROM selections WHERE cwd = ?")
            .get(canonicalCwd(cwd)) as { scope: string } | undefined;
        return selected?.scope === "global";
    }
    selectScope(
        cwd: string,
        mode: "workspace" | "global",
        nowMs = Date.now(),
    ): string {
        const scope = mode === "global" ? "global" : defaultMemoryScope(cwd);
        this.transaction(() => {
            const old = this.scopeFor(cwd);
            this.ensureScope(old);
            this.ensureScope(scope);
            this.database
                .prepare(
                    "UPDATE scopes SET generation = generation + 1 WHERE scope = ?",
                )
                .run(old);
            // Sessions in this folder now belong to the other scope; both scopes' jobs restart.
            this.bumpEpoch(old, nowMs, true);
            this.bumpEpoch(scope, nowMs, true);
            if (mode === "global")
                this.database
                    .prepare(
                        "INSERT OR REPLACE INTO selections(cwd,scope) VALUES (?,?)",
                    )
                    .run(canonicalCwd(cwd), scope);
            else
                this.database
                    .prepare("DELETE FROM selections WHERE cwd = ?")
                    .run(canonicalCwd(cwd));
        });
        return scope;
    }
    registerRepository(repository: RepositoryLocation): void {
        if (repository.scope !== repositoryScope(repository.commonDirectory))
            throw new Error("Invalid repository identity.");
        this.transaction(() => {
            this.ensureScope(repository.scope);
            const prior = this.repository(repository.scope);
            const worktreeRoots = [
                ...new Set([
                    ...(prior?.worktreeRoots ?? []),
                    repository.worktreeRoot,
                ]),
            ];
            this.database
                .prepare(
                    "INSERT OR REPLACE INTO repositories(scope,value) VALUES (?,?)",
                )
                .run(
                    repository.scope,
                    JSON.stringify({
                        scope: repository.scope,
                        name: repository.name,
                        commonDirectory: repository.commonDirectory,
                        worktreeRoots,
                        sessionDirectories: prior?.sessionDirectories ?? [],
                    }),
                );
        });
    }
    registerSessionDirectory(scope: string, directory: string): void {
        this.transaction(() => {
            const repository = this.repository(scope);
            if (!repository) throw new Error("Unknown repository.");
            const sessionDirectories = [
                ...new Set([
                    ...(repository.sessionDirectories ?? []),
                    canonicalCwd(directory),
                ]),
            ];
            this.database
                .prepare("UPDATE repositories SET value = ? WHERE scope = ?")
                .run(
                    JSON.stringify({ ...repository, sessionDirectories }),
                    scope,
                );
        });
    }
    repositories(): RegisteredRepository[] {
        return (
            this.database
                .prepare("SELECT value FROM repositories ORDER BY scope")
                .all() as { value: string }[]
        ).map((row) => JSON.parse(row.value) as RegisteredRepository);
    }
    /** Exact lookup for internal scope IDs; a repository name never stands in for an unregistered or non-repository scope. */
    repository(scope: string): RegisteredRepository | undefined {
        const row = this.database
            .prepare("SELECT value FROM repositories WHERE scope = ?")
            .get(scope) as { value: string } | undefined;
        return row
            ? (JSON.parse(row.value) as RegisteredRepository)
            : undefined;
    }
    /** Resolves a user-supplied repository selector: scope ID, unique name, or registered root path. */
    resolveRepository(selector: string): RegisteredRepository | undefined {
        const repositories = this.repositories();
        const exact = repositories.find(
            (repository) => repository.scope === selector,
        );
        if (exact) return exact;
        if (isAbsolute(selector)) {
            const canonical = canonicalCwd(selector);
            const common = repositories.find(
                (repository) =>
                    repository.commonDirectory === canonical &&
                    repositoryScope(canonical) === repository.scope,
            );
            if (common) return common;
            const location = findRepository(selector);
            const live = repositories.find(
                (repository) => repository.scope === location?.scope,
            );
            if (live) return live;
        }
        const matches = repositories.filter(
            (repository) =>
                repository.name === selector ||
                (repository.commonDirectory === selector &&
                    repositoryScope(selector) === repository.scope) ||
                (repository.worktreeRoots.includes(selector) &&
                    findRepository(selector)?.scope === repository.scope),
        );
        if (matches.length > 1)
            throw new Error(
                "Ambiguous repository name. Use its exact scope ID or registered root path.",
            );
        return matches[0];
    }
    readLink(
        sourceScope: string,
        targetScope: string,
    ): { isEnabled: boolean; revision: number } {
        const row = this.database
            .prepare(
                "SELECT enabled,revision FROM repository_reads WHERE source_scope = ? AND target_scope = ?",
            )
            .get(sourceScope, targetScope) as
            | { enabled: number; revision: number }
            | undefined;
        return { isEnabled: row?.enabled === 1, revision: row?.revision ?? 0 };
    }
    setReadLink(
        sourceScope: string,
        targetScope: string,
        isEnabled: boolean,
    ): void {
        if (sourceScope === targetScope || !this.repository(targetScope))
            throw new MemoryUserError(
                "Select a different registered repository.",
            );
        this.transaction(() => {
            this.ensureScope(sourceScope);
            this.database
                .prepare(`INSERT INTO repository_reads(source_scope,target_scope,enabled,revision) VALUES(?,?,?,1)
                ON CONFLICT(source_scope,target_scope) DO UPDATE SET enabled=excluded.enabled,revision=revision+1`)
                .run(sourceScope, targetScope, isEnabled ? 1 : 0);
        });
    }
    legacyMemories(cwd: string, targetScope?: string) {
        const scope = workspaceScope(cwd),
            nowMs = Date.now(),
            settings = this.getSettings(scope);
        const records = this.records(scope, nowMs).filter(
            (record) =>
                record.isPinned ||
                nowMs - (record.lastUsedAtMs || record.generatedAtMs) <=
                    settings.maxUnusedDays * 86_400_000,
        );
        const excluded = new Set(
            (
                this.database
                    .prepare(
                        "SELECT source_id FROM tombstones WHERE scope IN (?,?)",
                    )
                    .all(scope, targetScope ?? scope) as { source_id: string }[]
            ).map((row) => row.source_id),
        );
        const affectedPaths = targetScope
            ? this.records(targetScope, 0)
                  .filter((record) =>
                      excluded.has(record.source?.id ?? record.id),
                  )
                  .map((record) => record.path)
            : [];
        return {
            scope,
            revision: this.state(scope).revision,
            records: records.filter(
                (record) => !excluded.has(record.source?.id ?? record.id),
            ),
            excludedSources: excluded.size,
            affectedPaths,
        };
    }
    importLegacy(
        cwd: string,
        targetScope: string,
        recordIds: readonly string[],
        sourceRevision: number,
        targetRevision: number,
        nowMs = Date.now(),
    ) {
        const sourceScope = workspaceScope(cwd);
        if (
            sourceScope === targetScope ||
            findRepository(cwd)?.scope !== targetScope
        )
            throw new MemoryUserError(
                "Legacy cwd must belong to the active Git repository.",
            );
        if (new Set(recordIds).size !== recordIds.length)
            throw new MemoryUserError("Select distinct records.");
        return this.transaction(() => {
            this.ensureScope(targetScope);
            if (
                this.state(sourceScope).revision !== sourceRevision ||
                this.state(targetScope).revision !== targetRevision
            )
                throw new MemoryUserError(
                    "Memory changed during confirmation. Select the records again.",
                );
            if (
                this.database
                    .prepare(
                        "SELECT 1 FROM jobs WHERE scope IN (?,?) AND owner IS NOT NULL AND lease_until > ?",
                    )
                    .get(sourceScope, targetScope, nowMs)
            )
                throw new MemoryUserError(
                    "A memory job is active. Retry importing after it finishes.",
                );
            const oldSettings = this.getSettings(sourceScope),
                allSource = this.records(sourceScope, 0);
            const excluded = new Set(
                (
                    this.database
                        .prepare(
                            "SELECT source_id FROM tombstones WHERE scope IN (?,?)",
                        )
                        .all(sourceScope, targetScope) as {
                        source_id: string;
                    }[]
                ).map((row) => row.source_id),
            );
            const sourceRecordsById = new Map(
                allSource.map((record) => [record.id, record]),
            );
            const selected = recordIds.map((id) => {
                const record = sourceRecordsById.get(id);
                if (!record)
                    throw new MemoryUserError(
                        "A selected legacy record no longer exists.",
                    );
                return record;
            });
            let imported = 0,
                skipped = 0,
                removed = 0,
                exclusionsAdded = 0;
            for (const id of excluded)
                exclusionsAdded += Number(
                    this.database
                        .prepare(
                            "INSERT OR IGNORE INTO tombstones(scope,source_id) VALUES (?,?)",
                        )
                        .run(targetScope, id).changes,
                );
            for (const record of this.records(targetScope, 0))
                if (excluded.has(record.source?.id ?? record.id)) {
                    this.database
                        .prepare(
                            "DELETE FROM records WHERE scope = ? AND id = ?",
                        )
                        .run(targetScope, record.id);
                    removed++;
                }
            const recordsById = new Map(
                this.records(targetScope, 0).map((record) => [
                    record.id,
                    record,
                ]),
            );
            const recordPaths = new Set(
                [...recordsById.values()].map((record) => record.path),
            );
            for (const record of selected) {
                if (
                    excluded.has(record.source?.id ?? record.id) ||
                    (record.expiresAtMs !== null &&
                        record.expiresAtMs <= nowMs) ||
                    (!record.isPinned &&
                        nowMs - (record.lastUsedAtMs || record.generatedAtMs) >
                            oldSettings.maxUnusedDays * 86_400_000)
                ) {
                    skipped++;
                    continue;
                }
                const duplicate = recordsById.get(record.id);
                if (duplicate) {
                    if (
                        duplicate.body !== record.body ||
                        duplicate.kind !== record.kind
                    )
                        throw new MemoryUserError(
                            `A different version of ${this.mask(record.path)} already exists in this repository; no records were imported. Deselect it or resolve the existing record first.`,
                        );
                    skipped++;
                    continue;
                }
                let path = record.path;
                if (recordPaths.has(path)) {
                    if (record.kind !== "note")
                        throw new MemoryUserError(
                            `Conflicting rollout path ${this.mask(path)}; no records were imported.`,
                        );
                    path = `extensions/ad_hoc/notes/imported-${digest(sourceScope + record.id).slice(0, 24)}.md`;
                    if (recordPaths.has(path))
                        throw new MemoryUserError(
                            `Conflicting imported note path ${path}; no records were imported.`,
                        );
                }
                const copy = {
                    ...record,
                    path,
                    body: this.mask(record.body),
                    lastUsedAtMs: nowMs,
                    usageCount: 0,
                    importedFrom: {
                        scope: sourceScope,
                        cwd: this.mask(canonicalCwd(cwd)),
                        path: record.path,
                        importedAtMs: nowMs,
                    },
                };
                this.put(targetScope, copy);
                recordsById.set(copy.id, copy);
                recordPaths.add(path);
                imported++;
            }
            if (imported || removed || exclusionsAdded) {
                this.changed(targetScope, true);
                this.bumpEpoch(targetScope, nowMs, false);
                this.publish(targetScope, nowMs);
            }
            return {
                imported,
                skipped,
                removed,
                excludedSources: excluded.size,
            };
        });
    }
    getSettings(scope: string): MemorySettings {
        const row = this.database
            .prepare("SELECT value FROM settings WHERE scope = ?")
            .get(scope) as { value: string } | undefined;
        return parseSettings(row ? JSON.parse(row.value) : DEFAULT_SETTINGS);
    }
    saveSettings(
        scope: string,
        value: unknown,
        nowMs = Date.now(),
    ): MemorySettings {
        const settings = parseSettings(value);
        this.transaction(() => {
            this.ensureScope(scope);
            this.database
                .prepare(
                    "INSERT OR REPLACE INTO settings(scope,value) VALUES (?,?)",
                )
                .run(scope, JSON.stringify(settings));
            this.database
                .prepare(
                    "UPDATE scopes SET generation = generation + 1 WHERE scope = ?",
                )
                .run(scope);
            this.bumpEpoch(scope, nowMs, true);
        });
        return settings;
    }
    /**
     * Counts changes that void running jobs: settings, scope selection, edits, forgetting and
     * imports. New memories, notes and expiry do not, so parallel jobs do not void each other.
     */
    epoch(scope: string): number {
        const row = this.database
            .prepare("SELECT value FROM epochs WHERE scope = ?")
            .get(scope) as { value: number } | undefined;
        return row?.value ?? 0;
    }
    /** When the epoch last changed, for example when memory was turned on; 0 if never. */
    epochChangedAt(scope: string): number {
        const row = this.database
            .prepare("SELECT changed_at FROM epochs WHERE scope = ?")
            .get(scope) as { changed_at: number } | undefined;
        return row?.changed_at ?? 0;
    }
    /**
     * Voids running jobs: their leases end now, so no session shows or waits for them. Settings
     * and scope changes also restart the heartbeat period; edits and forgetting do not.
     */
    private bumpEpoch(
        scope: string,
        nowMs: number,
        isHeartbeatChange: boolean,
    ): void {
        this.database
            .prepare(
                `INSERT INTO epochs(scope,value,changed_at) VALUES (?,1,?) ON CONFLICT(scope) DO UPDATE SET value = value + 1${isHeartbeatChange ? ", changed_at = excluded.changed_at" : ""}`,
            )
            .run(scope, isHeartbeatChange ? nowMs : 0);
        this.database
            .prepare(
                "UPDATE jobs SET owner = NULL, lease_until = 0, status = 'cancelled', finished_at = ?, attempts = MAX(0, attempts - 1), error = 'superseded' WHERE scope = ? AND owner IS NOT NULL",
            )
            .run(nowMs, scope);
    }
    state(scope: string): ScopeState {
        const row = this.database
            .prepare("SELECT * FROM scopes WHERE scope = ?")
            .get(scope) as
            | {
                  revision: number;
                  generation: number;
                  summary: string;
                  consolidated_at: number;
                  inputs: string;
              }
            | undefined;
        return row
            ? {
                  revision: row.revision,
                  generation: row.generation,
                  summary: row.summary,
                  consolidatedAtMs: row.consolidated_at,
                  inputs: JSON.parse(row.inputs),
              }
            : {
                  revision: 0,
                  generation: 0,
                  summary: "",
                  consolidatedAtMs: 0,
                  inputs: {},
              };
    }
    records(scope: string, nowMs = Date.now()): MemoryRecord[] {
        const rows = this.database
            .prepare("SELECT value FROM records WHERE scope = ? ORDER BY path")
            .all(scope) as { value: string }[];
        return rows
            .map((row) => JSON.parse(row.value) as MemoryRecord)
            .filter(
                (record) =>
                    record.expiresAtMs === null || record.expiresAtMs > nowMs,
            );
    }
    isForgotten(scope: string, sourceId: string): boolean {
        return !!this.database
            .prepare(
                "SELECT 1 FROM tombstones WHERE scope = ? AND source_id = ?",
            )
            .get(scope, sourceId);
    }
    isSourceExcluded(scope: string, source: RolloutSource): boolean {
        return (
            this.isForgotten(scope, source.id) ||
            (scope !== "global" && this.selectsGlobal(source.cwd)) ||
            (scope.startsWith("repository-") &&
                ((source.repository?.scope ?? workspaceScope(source.cwd)) !==
                    scope ||
                    this.isForgotten(workspaceScope(source.cwd), source.id)))
        );
    }
    private put(scope: string, record: MemoryRecord): void {
        this.database
            .prepare(
                "INSERT OR REPLACE INTO records(scope,id,path,value) VALUES (?,?,?,?)",
            )
            .run(scope, record.id, record.path, JSON.stringify(record));
    }
    private changed(scope: string, invalidate: boolean): void {
        this.database
            .prepare(
                `UPDATE scopes SET revision = revision + 1${invalidate ? ", summary = '', generation = generation + 1" : ""} WHERE scope = ?`,
            )
            .run(scope);
    }
    claim(
        scope: string,
        key: string,
        fingerprint: string,
        nowMs: number,
        settings: MemorySettings,
        force = false,
    ): JobLease | null {
        return this.transaction(() => {
            this.ensureScope(scope);
            const row = this.job(scope, key);
            if (!canClaim(row, fingerprint, nowMs, settings, force))
                return null;
            const isSame = row?.fingerprint === fingerprint;
            const owner = randomUUID();
            this.database
                .prepare(`INSERT OR REPLACE INTO jobs(scope,key,fingerprint,owner,lease_until,retry_at,attempts,status)
                VALUES (?,?,?,?,?,0,?,'running')`)
                .run(
                    scope,
                    key,
                    fingerprint,
                    owner,
                    nowMs + settings.timeoutMs + 10_000,
                    isSame && !force ? (row?.attempts ?? 0) + 1 : 1,
                );
            return {
                scope,
                key,
                owner,
                fingerprint,
                epoch: this.epoch(scope),
            };
        });
    }
    private job(scope: string, key: string): JobRow | undefined {
        return this.database
            .prepare("SELECT * FROM jobs WHERE scope = ? AND key = ?")
            .get(scope, key) as unknown as JobRow | undefined;
    }
    /** Whether claim() would take the job now, so a coordinator skips waiting jobs before validating a model. */
    isClaimable(
        scope: string,
        key: string,
        fingerprint: string,
        nowMs: number,
        settings: MemorySettings,
        force = false,
    ): boolean {
        return canClaim(
            this.job(scope, key),
            fingerprint,
            nowMs,
            settings,
            force,
        );
    }
    /** When the job last succeeded; a session file not modified since then needs no reading. */
    succeededAt(scope: string, key: string): number | undefined {
        const row = this.database
            .prepare(
                "SELECT finished_at FROM jobs WHERE scope = ? AND key = ? AND status = 'succeeded'",
            )
            .get(scope, key) as { finished_at: number } | undefined;
        return row?.finished_at;
    }
    /** Jobs running now in a scope, in any Pi process. */
    runningJobs(
        scope: string,
        nowMs: number,
    ): { extractions: number; isConsolidating: boolean } {
        const keys = (
            this.database
                .prepare(
                    "SELECT key FROM jobs WHERE scope = ? AND owner IS NOT NULL AND lease_until > ?",
                )
                .all(scope, nowMs) as { key: string }[]
        ).map((row) => row.key);
        return {
            extractions: keys.filter((key) => key.startsWith("extract:"))
                .length,
            isConsolidating: keys.includes("consolidation"),
        };
    }
    /**
     * Whether a job in the scope failed since `sinceMs` and has not succeeded since, in any Pi
     * process. A later success replaces the job's row; a forgotten conversation's failure no
     * longer counts.
     */
    hasRecentFailure(scope: string, sinceMs: number): boolean {
        const keys = this.database
            .prepare(
                "SELECT key FROM jobs WHERE scope = ? AND status IN ('failed','blocked') AND finished_at > ?",
            )
            .all(scope, sinceMs) as { key: string }[];
        return keys.some(
            ({ key }) =>
                !key.startsWith("extract:") ||
                !this.isForgotten(scope, key.slice("extract:".length)),
        );
    }
    hasCompleted(scope: string, key: string, fingerprint: string): boolean {
        return !!this.database
            .prepare(
                "SELECT 1 FROM jobs WHERE scope = ? AND key = ? AND fingerprint = ? AND status = 'succeeded'",
            )
            .get(scope, key, fingerprint);
    }
    block(
        scope: string,
        key: string,
        fingerprint: string,
        nowMs: number,
        code: MemoryFailureCode,
    ): void {
        this.transaction(() => {
            this.ensureScope(scope);
            const row = this.database
                .prepare("SELECT * FROM jobs WHERE scope = ? AND key = ?")
                .get(scope, key) as unknown as JobRow | undefined;
            if (row?.owner && row.lease_until > nowMs) return;
            this.database
                .prepare(`INSERT OR REPLACE INTO jobs(scope,key,fingerprint,attempts,status,finished_at,error)
                VALUES (?,?,?,?,'blocked',?,?)`)
                .run(
                    scope,
                    key,
                    fingerprint,
                    row?.fingerprint === fingerprint ? row.attempts : 0,
                    nowMs,
                    code,
                );
        });
    }
    private owns(lease: JobLease, nowMs: number): boolean {
        const row = this.database
            .prepare(
                "SELECT owner,lease_until FROM jobs WHERE scope = ? AND key = ?",
            )
            .get(lease.scope, lease.key) as
            | { owner: string; lease_until: number }
            | undefined;
        return (
            row?.owner === lease.owner &&
            row.lease_until > nowMs &&
            this.epoch(lease.scope) === lease.epoch
        );
    }
    /** Confirms the lease still owns the job right before a model call, then counts the call in today's usage. */
    recordCall(lease: JobLease, nowMs: number, source?: RolloutSource): void {
        this.transaction(() => {
            // A scope selection can change after the lease was claimed without changing settings.
            if (
                !this.owns(lease, nowMs) ||
                !this.getSettings(lease.scope).generateMemories ||
                (source && this.isSourceExcluded(lease.scope, source))
            )
                throw new MemoryFailure("superseded");
            const day = new Date(nowMs).toISOString().slice(0, 10);
            this.database
                .prepare("INSERT OR IGNORE INTO usage(scope,day) VALUES (?,?)")
                .run(lease.scope, day);
            this.database
                .prepare(
                    "UPDATE usage SET calls = calls + 1 WHERE scope = ? AND day = ?",
                )
                .run(lease.scope, day);
        });
    }
    recordUsage(
        scope: string,
        usage: MemoryUsage | undefined,
        nowMs: number,
    ): void {
        if (!usage) return;
        const finite = (value: number | undefined) =>
            Number.isFinite(value) && Number(value) >= 0 ? Number(value) : 0;
        this.database
            .prepare(
                "UPDATE usage SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost = cost + ? WHERE scope = ? AND day = ?",
            )
            .run(
                finite(usage.input) +
                    finite(usage.cacheRead) +
                    finite(usage.cacheWrite),
                finite(usage.output),
                finite(usage.cost?.total),
                scope,
                new Date(nowMs).toISOString().slice(0, 10),
            );
    }
    private succeeded(lease: JobLease, nowMs: number): void {
        this.database
            .prepare(
                "UPDATE jobs SET owner = NULL, status = 'succeeded', finished_at = ?, error = '' WHERE scope = ? AND key = ? AND owner = ?",
            )
            .run(nowMs, lease.scope, lease.key, lease.owner);
    }
    fail(
        lease: JobLease,
        nowMs: number,
        delayMs: number,
        isCancelled: boolean,
        code: MemoryFailureCode = "storage",
    ): void {
        this.database
            .prepare(
                "UPDATE jobs SET owner = NULL, status = ?, retry_at = ?, finished_at = ?, attempts = CASE WHEN ? THEN MAX(0, attempts - 1) ELSE attempts END, error = ? WHERE scope = ? AND key = ? AND owner = ?",
            )
            .run(
                isCancelled ? "cancelled" : "failed",
                nowMs + (isCancelled ? 0 : delayMs),
                nowMs,
                isCancelled ? 1 : 0,
                isCancelled ? "aborted" : code,
                lease.scope,
                lease.key,
                lease.owner,
            );
    }
    completeExtraction(
        lease: JobLease,
        source: RolloutSource,
        summary: string,
        slug: string,
        nowMs: number,
        wasNormalized = false,
    ): boolean {
        return this.transaction(() => {
            if (
                !this.owns(lease, nowMs) ||
                this.isSourceExcluded(lease.scope, source)
            )
                return false;
            const prior = this.records(lease.scope, nowMs).find(
                (record) => record.id === source.id,
            );
            const masked = this.mask(summary).trim();
            const marker =
                "\n[Middle omitted at memory storage limit; missing evidence is unknown.]\n";
            const body = truncateMiddleBytes(masked, SUMMARY_MAX_BYTES, marker);
            const truncatedBytes =
                body === masked
                    ? 0
                    : Buffer.byteLength(masked) -
                      Buffer.byteLength(body) +
                      Buffer.byteLength(marker);
            if (body) {
                const { text: _text, ...provenance } = source;
                const safeSlug =
                    this.mask(slug)
                        .toLowerCase()
                        .replace(/[^a-z0-9-]+/g, "-")
                        .replace(/^-|-$/g, "")
                        .slice(0, 60) || "session";
                this.put(lease.scope, {
                    id: source.id,
                    path: `rollout_summaries/${digest(source.id).slice(0, 16)}-${safeSlug}.md`,
                    kind: "rollout",
                    body,
                    truncatedBytes,
                    wasNormalized,
                    source: {
                        ...provenance,
                        cwd: this.mask(provenance.cwd),
                        file: this.mask(provenance.file),
                        ...(provenance.repository
                            ? {
                                  repository: {
                                      ...provenance.repository,
                                      commonDirectory: this.mask(
                                          provenance.repository.commonDirectory,
                                      ),
                                      worktreeRoot: this.mask(
                                          provenance.repository.worktreeRoot,
                                      ),
                                      branchAtCapture:
                                          provenance.repository
                                              .branchAtCapture === null
                                              ? null
                                              : this.mask(
                                                    provenance.repository
                                                        .branchAtCapture,
                                                ),
                                  },
                              }
                            : {}),
                    },
                    generatedAtMs: nowMs,
                    lastUsedAtMs: prior?.lastUsedAtMs ?? 0,
                    usageCount: prior?.usageCount ?? 0,
                    isPinned: prior?.isPinned ?? false,
                    expiresAtMs: prior?.expiresAtMs ?? null,
                });
            } else
                this.database
                    .prepare("DELETE FROM records WHERE scope = ? AND id = ?")
                    .run(lease.scope, source.id);
            if (body || prior) this.changed(lease.scope, !!prior);
            this.succeeded(lease, nowMs);
            this.publish(lease.scope, nowMs);
            return true;
        });
    }
    completeConsolidation(
        lease: JobLease,
        revision: number,
        inputs: Record<string, string>,
        summary: string,
        nowMs: number,
    ): boolean {
        return this.transaction(() => {
            if (
                !this.owns(lease, nowMs) ||
                this.state(lease.scope).revision !== revision
            )
                return false;
            this.database
                .prepare(
                    "UPDATE scopes SET summary = ?, inputs = ?, consolidated_at = ? WHERE scope = ?",
                )
                .run(
                    this.mask(summary),
                    JSON.stringify(inputs),
                    // Only a summary the model wrote starts the interval; an empty template does not.
                    Object.keys(inputs).length ? nowMs : 0,
                    lease.scope,
                );
            this.succeeded(lease, nowMs);
            this.publish(lease.scope, nowMs);
            return true;
        });
    }
    addNote(
        scope: string,
        note: string,
        nowMs = Date.now(),
        filename?: string,
    ): MemoryRecord {
        const body = this.mask(note).trim();
        if (!body || Buffer.byteLength(body) > SUMMARY_MAX_BYTES)
            throw new Error("Note must contain 1–9000 UTF-8 bytes.");
        if (filename && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\.md$/.test(filename))
            throw new Error("Invalid note filename.");
        return this.transaction(() => {
            this.ensureScope(scope);
            const id = randomUUID();
            const record: MemoryRecord = {
                id,
                path: `extensions/ad_hoc/notes/${filename ?? `${id}.md`}`,
                kind: "note",
                body,
                source: null,
                generatedAtMs: nowMs,
                lastUsedAtMs: 0,
                usageCount: 0,
                isPinned: true,
                expiresAtMs: null,
            };
            if (
                this.records(scope, nowMs).some(
                    (item) => item.path === record.path,
                )
            )
                throw new Error("Note already exists.");
            this.put(scope, record);
            this.changed(scope, true);
            this.publish(scope, nowMs);
            return record;
        });
    }
    /** Replaces a memory with an edited note, or forgets it with null; returns the note's path. */
    revise(
        scope: string,
        path: string,
        body: string | null,
        nowMs = Date.now(),
    ): string | undefined {
        return this.transaction(() => {
            this.ensureScope(scope);
            const record = this.records(scope, nowMs).find(
                (item) => item.path === path,
            );
            if (!record) throw new MemoryUserError("Memory record not found.");
            this.database
                .prepare(
                    "INSERT OR IGNORE INTO tombstones(scope,source_id) VALUES (?,?)",
                )
                .run(scope, record.source?.id ?? record.id);
            this.database
                .prepare("DELETE FROM records WHERE scope = ? AND id = ?")
                .run(scope, record.id);
            let notePath: string | undefined;
            if (body !== null) {
                const masked = this.mask(body).trim();
                if (!masked || Buffer.byteLength(masked) > SUMMARY_MAX_BYTES)
                    throw new MemoryUserError(
                        "Correction must contain 1–9000 UTF-8 bytes.",
                    );
                const id = randomUUID();
                notePath = `extensions/ad_hoc/notes/${id}.md`;
                this.put(scope, {
                    ...record,
                    id,
                    source: null,
                    importedFrom: undefined,
                    kind: "note",
                    path: notePath,
                    body: masked,
                    isPinned: true,
                    generatedAtMs: nowMs,
                });
            }
            this.database
                .prepare(
                    "UPDATE scopes SET generation = generation + 1 WHERE scope = ?",
                )
                .run(scope);
            this.bumpEpoch(scope, nowMs, false);
            this.changed(scope, true);
            this.publish(scope, nowMs);
            return notePath;
        });
    }
    setRetention(
        scope: string,
        path: string,
        isPinned: boolean,
        expiresAtMs: number | null,
    ): void {
        if (
            expiresAtMs !== null &&
            (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now())
        )
            throw new Error("Expiry must be a future timestamp.");
        this.transaction(() => {
            const record = this.records(scope).find(
                (item) => item.path === path,
            );
            if (!record) throw new MemoryUserError("Memory record not found.");
            this.put(scope, { ...record, isPinned, expiresAtMs });
            this.changed(scope, false);
        });
    }
    prune(scope: string, settings: MemorySettings, nowMs: number): void {
        this.transaction(() => {
            this.ensureScope(scope);
            const rows = this.database
                .prepare("SELECT value FROM records WHERE scope = ?")
                .all(scope) as { value: string }[];
            let changed = false;
            for (const row of rows) {
                const record = JSON.parse(row.value) as MemoryRecord;
                const expired =
                    record.expiresAtMs !== null && record.expiresAtMs <= nowMs;
                const unused =
                    !record.isPinned &&
                    nowMs - (record.lastUsedAtMs || record.generatedAtMs) >
                        settings.maxUnusedDays * 86_400_000;
                if (!expired && !unused) continue;
                this.database
                    .prepare("DELETE FROM records WHERE scope = ? AND id = ?")
                    .run(scope, record.id);
                changed = true;
                this.database
                    .prepare(
                        "INSERT OR IGNORE INTO tombstones(scope,source_id) VALUES (?,?)",
                    )
                    .run(scope, record.source?.id ?? record.id);
            }
            if (changed) {
                this.changed(scope, true);
                this.database
                    .prepare(
                        "UPDATE scopes SET generation = generation + 1 WHERE scope = ?",
                    )
                    .run(scope);
                this.publish(scope, nowMs);
            }
        });
    }
    reset(scope: string, nowMs = Date.now()): void {
        this.transaction(() => {
            this.ensureScope(scope);
            for (const record of this.records(scope, 0))
                this.database
                    .prepare(
                        "INSERT OR IGNORE INTO tombstones(scope,source_id) VALUES (?,?)",
                    )
                    .run(scope, record.source?.id ?? record.id);
            this.database
                .prepare("DELETE FROM records WHERE scope = ?")
                .run(scope);
            this.database
                .prepare(
                    "UPDATE scopes SET generation = generation + 1, revision = revision + 1, summary = '' WHERE scope = ?",
                )
                .run(scope);
            this.bumpEpoch(scope, nowMs, false);
            this.publish(scope, nowMs);
        });
    }
    markUsed(
        scope: string,
        paths: readonly string[],
        nowMs = Date.now(),
    ): void {
        this.transaction(() => {
            for (const record of this.records(scope, nowMs))
                if (paths.includes(record.path))
                    this.put(scope, {
                        ...record,
                        usageCount: record.usageCount + 1,
                        lastUsedAtMs: nowMs,
                    });
        });
    }
    activity(
        scope: string,
        sessionId: string,
        owner: string,
        isBusy: boolean,
        nowMs: number,
    ): void {
        this.database
            .prepare(
                "INSERT OR REPLACE INTO activity(scope,session_id,owner,busy,expires_at) VALUES (?,?,?,?,?)",
            )
            .run(
                scope,
                sessionId,
                owner,
                isBusy ? 1 : 0,
                nowMs + ACTIVITY_TTL_MS,
            );
    }
    /** Whether any Pi process with memory on still holds this session open, in any scope. */
    isSessionOpen(sessionId: string, nowMs: number): boolean {
        return !!this.database
            .prepare(
                "SELECT 1 FROM activity WHERE session_id = ? AND expires_at > ?",
            )
            .get(sessionId, nowMs);
    }
    /**
     * Takes or renews the scope's coordinator lease. One Pi process per scope coordinates memory
     * jobs; another takes over once the lease lapses.
     */
    lead(scope: string, owner: string, nowMs: number): boolean {
        return this.transaction(() => {
            this.ensureScope(scope);
            const row = this.database
                .prepare(
                    "SELECT owner, lease_until FROM coordinators WHERE scope = ?",
                )
                .get(scope) as
                | { owner: string; lease_until: number }
                | undefined;
            if (row && row.owner !== owner && row.lease_until > nowMs)
                return false;
            this.database
                .prepare(
                    "INSERT OR REPLACE INTO coordinators(scope,owner,lease_until) VALUES (?,?,?)",
                )
                .run(scope, owner, nowMs + ACTIVITY_TTL_MS);
            return true;
        });
    }
    /** Removes heartbeats and leases a crashed or killed Pi process left behind. */
    purgeExpired(nowMs: number): void {
        this.database
            .prepare("DELETE FROM activity WHERE expires_at <= ?")
            .run(nowMs);
        this.database
            .prepare("DELETE FROM coordinators WHERE lease_until <= ?")
            .run(nowMs);
    }
    releaseLead(owner: string): void {
        this.database
            .prepare("DELETE FROM coordinators WHERE owner = ?")
            .run(owner);
    }
    releaseActivity(owner: string): void {
        this.database
            .prepare("DELETE FROM activity WHERE owner = ?")
            .run(owner);
    }
    isBusy(scope: string, sessionId: string, nowMs: number): boolean {
        return !!this.database
            .prepare(
                "SELECT 1 FROM activity WHERE scope = ? AND session_id = ? AND busy = 1 AND expires_at > ?",
            )
            .get(scope, sessionId, nowMs);
    }
    status(scope: string): object {
        return {
            scope,
            root: this.artifactRoot(scope),
            settings: this.getSettings(scope),
            state: {
                ...this.state(scope),
                summary: undefined,
                inputs: undefined,
            },
            records: this.records(scope).length,
            truncatedRecords: this.records(scope).filter(
                (record) => (record.truncatedBytes ?? 0) > 0,
            ).length,
            normalizedRecords: this.records(scope).filter(
                (record) => record.wasNormalized,
            ).length,
            excludedSources: (
                this.database
                    .prepare(
                        "SELECT COUNT(*) AS count FROM tombstones WHERE scope = ?",
                    )
                    .get(scope) as { count: number }
            ).count,
            jobs: this.database
                .prepare(
                    "SELECT key,status,attempts,retry_at,error FROM jobs WHERE scope = ? ORDER BY rowid DESC LIMIT 20",
                )
                .all(scope),
            usage: this.database
                .prepare(
                    "SELECT * FROM usage WHERE scope = ? ORDER BY day DESC LIMIT 7",
                )
                .all(scope),
        };
    }
    artifactRoot(scope: string): string {
        if (!/^(global|(?:workspace|repository)-[a-f0-9]{24})$/.test(scope))
            throw new Error("Invalid memory scope.");
        return join(this.root, "scopes", scope);
    }
    document(record: MemoryRecord): string {
        const imported = record.importedFrom
            ? `imported_from_cwd: ${JSON.stringify(record.importedFrom.cwd)}\nimported_from_scope: ${record.importedFrom.scope}\n\n`
            : "";
        if (record.kind === "note") return imported + record.body;
        const repository = record.source?.repository;
        const context = repository
            ? `repository_scope: ${repository.scope}\nworktree_root: ${JSON.stringify(repository.worktreeRoot)}\ngit_branch_at_capture: ${JSON.stringify(repository.branchAtCapture)}\ngit_observed_at: ${new Date(repository.capturedAtMs).toISOString()}\nrepository_binding: ${repository.binding}\n`
            : "";
        return `thread_id: ${record.source?.id}\ncwd: ${record.source?.cwd}\nsource_entry: ${record.source?.leafId}\nupdated_at: ${new Date(record.source?.updatedAtMs ?? 0).toISOString()}\n${context}\n${imported}${record.body}`;
    }
    /** Called under the SQLite writer lock; retrieval never trusts Markdown over the DB. */
    private publish(scope: string, nowMs: number): void {
        privateDirectory(join(this.root, "scopes"));
        const root = this.artifactRoot(scope);
        privateDirectory(root);
        privateDirectory(join(root, "extensions"));
        privateDirectory(join(root, "extensions", "ad_hoc"));
        const directories = ["rollout_summaries", "extensions/ad_hoc/notes"];
        const records = this.records(scope, nowMs);
        for (const directory of directories)
            privateDirectory(join(root, directory));
        const expected = new Set(records.map((record) => record.path));
        const previous = this.database
            .prepare("SELECT path FROM artifact_paths WHERE scope = ?")
            .all(scope) as { path: string }[];
        for (const { path } of previous) {
            if (expected.has(path)) continue;
            if (
                !/^(rollout_summaries|extensions\/ad_hoc\/notes)\/[A-Za-z0-9_-]+\.md$/.test(
                    path,
                )
            )
                throw new Error("Unsafe memory artifact path.");
            const target = join(root, path);
            try {
                if (
                    lstatSync(target).isSymbolicLink() ||
                    !lstatSync(target).isFile()
                )
                    throw new Error("Unsafe memory artifact.");
                unlinkSync(target);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
            }
        }
        for (const record of records)
            atomicWrite(join(root, record.path), this.document(record));
        this.database
            .prepare("DELETE FROM artifact_paths WHERE scope = ?")
            .run(scope);
        for (const record of records)
            this.database
                .prepare("INSERT INTO artifact_paths(scope,path) VALUES (?,?)")
                .run(scope, record.path);
        atomicWrite(join(root, "memory_summary.md"), this.state(scope).summary);
    }
}
