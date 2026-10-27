import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isMemoryEnabled, type MemorySettings } from "./config.js";
import {
    MemoryCoordinator,
    type MemoryCreationRange,
    type RunTally,
} from "./coordinator.js";
import { MemoryUserError } from "./failure.js";
import { type PipelineResult, piMemoryModel, runPipeline } from "./pipeline.js";
import { findRepository, type RepositoryLocation } from "./repositories.js";
import { RepositoryAccess } from "./repository-access.js";
import { buildInjection, MemoryReader } from "./retrieval.js";
import { canonicalCwd, safeError } from "./safety.js";
import {
    currentSource,
    isSameSource,
    isSourceUnchanged,
    type MemoryExposure,
    scanSources,
    sourceScope,
} from "./sources.js";
import { MemoryStore } from "./store.js";

const JOBS_FAILED =
    "Some memory jobs failed. Open /codex-memory-settings and choose Show what failed.";

/**
 * Owns one Pi session's heartbeat, its memory coordinator and its cancellation, not the database's
 * cross-process locks. While memory is on, the heartbeat marks the session open so no coordinator
 * turns it into memory before it closes.
 */
export class MemoryRuntime {
    readonly store: MemoryStore;
    readonly scope: string;
    readonly reader: MemoryReader;
    readonly repository: RepositoryLocation | undefined;
    readonly access: RepositoryAccess;
    readonly sessionId: string;
    readonly cwd: string;
    private readonly owner = randomUUID();
    private readonly lifetime = new AbortController();
    private readonly now: () => number;
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    private readonly coordinator: MemoryCoordinator;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private operation: AbortController | undefined;
    private pending: Promise<PipelineResult> | undefined;
    private isBusy = false;
    private isManaging = false;
    private lastError: string | undefined;
    private snapshot = "";
    private snapshotGeneration = -1;
    private injectedBytes = 0;
    private recallMarker: MemoryExposure | undefined;
    /** Called when the status may have changed: jobs, failures, settings, and every heartbeat. */
    onChange: (() => void) | undefined;
    constructor(
        private ctx: ExtensionContext,
        readonly agentDir: string,
        options: {
            readonly now?: () => number;
            readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
        } = {},
    ) {
        this.now = options.now ?? Date.now;
        this.sleep =
            options.sleep ??
            ((ms, signal) => delay(ms, undefined, { signal, ref: false }));
        this.cwd = canonicalCwd(ctx.cwd);
        this.sessionId = ctx.sessionManager.getSessionId();
        this.store = new MemoryStore(join(agentDir, "pi-codex-memory"));
        this.repository = findRepository(this.cwd);
        if (this.repository) this.store.registerRepository(this.repository);
        this.scope = this.store.scopeFor(this.cwd);
        this.access = new RepositoryAccess(
            this.store,
            this.scope,
            this.lifetime.signal,
        );
        this.reader = new MemoryReader(this.store, this.scope, (scope) =>
            this.access.canRead(scope),
        );
        this.coordinator = new MemoryCoordinator({
            store: this.store,
            scope: this.scope,
            owner: this.owner,
            signal: this.lifetime.signal,
            now: this.now,
            sleep: this.sleep,
            context: () => this.ctx,
            scan: (settings, signal, shouldRead) =>
                this.scan(settings, signal, false, shouldRead),
            isPaused: () => this.isManaging,
            changed: () => this.changed(),
        });
    }
    updateContext(ctx: ExtensionContext): void {
        this.ctx = ctx;
    }
    settings(): MemorySettings {
        return this.store.getSettings(this.scope);
    }
    get signal(): AbortSignal {
        return this.lifetime.signal;
    }
    /** A job runs in this Pi session: the current conversation, or closed ones while it coordinates. */
    get isRunning(): boolean {
        return !!this.pending || this.coordinator.isWorking;
    }
    /**
     * An error outside jobs in this session, or a job in this scope that failed in any session
     * within the conversation window and has not succeeded since.
     */
    get failure(): string | undefined {
        if (this.lastError) return this.lastError;
        if (this.coordinator.error) return this.coordinator.error;
        const settings = this.settings();
        return this.store.hasRecentFailure(
            this.scope,
            this.now() - settings.maxRolloutAgeDays * 86_400_000,
        )
            ? JOBS_FAILED
            : undefined;
    }
    /** What memory jobs in this scope are doing now, in any Pi session, for the status bar. */
    activityText(): string | undefined {
        const { extractions, isConsolidating } = this.store.runningJobs(
            this.scope,
            this.now(),
        );
        if (extractions)
            return `creating ${extractions} ${extractions === 1 ? "memory" : "memories"}…`;
        if (isConsolidating || this.coordinator.isConsolidating)
            return "updating summary…";
        return this.failure ? "update failed" : undefined;
    }
    /** Short name of the active scope for menu titles and confirmations. */
    scopeName(): string {
        if (this.scope === "global") return "personal";
        if (this.repository?.scope === this.scope)
            return `${this.repository.name} (repository)`;
        return `${basename(this.cwd)} (folder)`;
    }
    /** A status display that fails must not stop the heartbeat or a job. */
    private changed(): void {
        try {
            this.onChange?.();
        } catch {}
    }
    private setFailure(value: string | undefined): void {
        this.lastError = value;
        this.changed();
    }
    start(): void {
        if (
            (this.ctx.mode !== "tui" && this.ctx.mode !== "rpc") ||
            !this.ctx.sessionManager.getSessionFile()
        )
            return;
        if (this.repository)
            this.store.registerSessionDirectory(
                this.repository.scope,
                this.ctx.sessionManager.getSessionDir(),
            );
        this.store.prune(this.scope, this.settings(), this.now());
        this.heartbeat();
        this.schedule();
    }
    /**
     * Marks this session open while a scope that can turn it into memory has memory on: the
     * folder's current scope, which another session may have changed, or Personal, which collects
     * every folder. Otherwise nothing is recorded.
     */
    private heartbeat(): void {
        if (
            isMemoryEnabled(
                this.store.getSettings(this.store.scopeFor(this.cwd)),
            ) ||
            isMemoryEnabled(this.store.getSettings("global"))
        )
            this.store.activity(
                this.scope,
                this.sessionId,
                this.owner,
                this.isBusy || !this.ctx.isIdle(),
                this.now(),
            );
        else this.store.releaseActivity(this.owner);
    }
    /**
     * One heartbeat: retention cleanup, the open-session mark and the coordinator. The timer runs
     * it at most every 30 seconds; it returns the scan the coordinator started, if any.
     */
    tick(): Promise<void> {
        if (this.lifetime.signal.aborted) return Promise.resolve();
        try {
            this.store.prune(this.scope, this.settings(), this.now());
            this.store.purgeExpired(this.now());
            this.heartbeat();
            if (this.lastError) this.setFailure(undefined);
        } catch (error) {
            this.setFailure(safeError(error));
        }
        const round = this.coordinator.tick();
        // Jobs in other sessions show up in this session's status at the next heartbeat.
        this.changed();
        return round;
    }
    private schedule(): void {
        if (this.lifetime.signal.aborted) return;
        clearTimeout(this.timer);
        let delayMs = 30_000;
        try {
            delayMs = Math.min(delayMs, this.settings().pollIntervalMs);
        } catch {
            // A busy database must not stop the heartbeat; try again at the longest interval.
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (this.lifetime.signal.aborted) return;
            void this.tick();
            this.schedule();
        }, delayMs);
        this.timer.unref();
    }
    private scan(
        settings: MemorySettings,
        signal: AbortSignal,
        allowUnmarked: boolean,
        shouldRead?: (path: string, mtimeMs: number) => boolean,
    ) {
        return scanSources({
            agentDir: this.agentDir,
            cwd: this.cwd,
            sessionDir: this.ctx.sessionManager.getSessionDir(),
            scope: this.scope,
            settings,
            signal,
            nowMs: this.now(),
            allowUnmarked,
            sessionDirectories: this.repository
                ? this.store.repository(this.repository.scope)
                      ?.sessionDirectories
                : undefined,
            isCwdExcluded:
                this.scope === "global"
                    ? undefined
                    : (cwd) => this.store.selectsGlobal(cwd),
            shouldRead,
        });
    }
    isActive(): boolean {
        return !this.lifetime.signal.aborted;
    }
    /** False once disposed or once this folder resolves to another memory scope; open menus close. */
    hasCurrentScope(): boolean {
        return this.isActive() && this.store.scopeFor(this.cwd) === this.scope;
    }
    setManaging(value: boolean): void {
        this.isManaging = value;
    }
    busy(): void {
        this.isBusy = true;
        this.operation?.abort();
        this.heartbeat();
    }
    /** Auto-compaction can resume the same run without before_agent_start, so request-local consent survives it. */
    compacted(): void {
        this.isBusy = false;
        this.heartbeat();
    }
    settled(): void {
        this.compacted();
        this.access.endRequest();
    }
    prepareInjection(): void {
        this.access.beginRequest();
        this.reader.resetObserved();
        this.injectedBytes = 0;
        this.recallMarker = undefined;
        this.snapshot = buildInjection(this.store, this.scope, this.settings());
        this.snapshotGeneration = this.store.state(this.scope).generation;
    }
    injection(): string {
        const settings = this.settings();
        if (!settings.useMemories || !settings.injectSummary) return "";
        this.store.prune(this.scope, settings, this.now());
        // Corrections, forgetting, scope/config changes and expiry invalidate even an active turn.
        if (
            this.snapshotGeneration !== this.store.state(this.scope).generation
        ) {
            this.snapshot = buildInjection(this.store, this.scope, settings);
            this.snapshotGeneration = this.store.state(this.scope).generation;
        }
        return this.snapshot;
    }
    /** One marker per request, plus one upgrade when foreign context follows local recall. */
    claimRecallMarker(exposure: MemoryExposure): boolean {
        if (this.recallMarker === "external" || this.recallMarker === exposure)
            return false;
        this.recallMarker = exposure;
        return true;
    }
    recordInjection(text: string): void {
        this.injectedBytes = Buffer.byteLength(text);
    }
    evidence() {
        return { injectedBytes: this.injectedBytes, ...this.reader.evidence() };
    }
    /** Stops the job for the current conversation; jobs for closed sessions keep running. */
    async cancelCurrent(): Promise<void> {
        this.operation?.abort();
        try {
            await this.pending;
        } catch {}
    }
    /**
     * Turns closed conversations in the selected age range into memory now, then updates the
     * summary. `onWait` reports a wait for open sessions to check in after a settings change.
     */
    createNow(
        onWait?: (ms: number) => void,
        range: MemoryCreationRange = "recent",
    ): Promise<RunTally> {
        return this.coordinator.runNow(onWait, range);
    }
    /** Stops every job this Pi session runs. A coordinator starts closed sessions again later. */
    async cancel(): Promise<void> {
        await Promise.all([this.cancelCurrent(), this.coordinator.cancel()]);
    }
    async run(mode: "current" | "import" | "refresh"): Promise<PipelineResult> {
        if (this.pending)
            throw new MemoryUserError("A memory job is already running.");
        if (this.isBusy || !this.ctx.isIdle())
            throw new MemoryUserError(
                "Memory generation waits for the foreground agent to become idle.",
            );
        const settings = this.settings();
        const settingsSnapshot = JSON.stringify(settings);
        if (!settings.generateMemories)
            throw new MemoryUserError("Turn memory on in /codex-memory first.");
        const operation = new AbortController();
        this.operation = operation;
        const signal = AbortSignal.any([
            operation.signal,
            this.lifetime.signal,
            ...(this.ctx.signal ? [this.ctx.signal] : []),
        ]);
        const ctx = this.ctx;
        const execute = async () => {
            const current =
                mode === "current"
                    ? currentSource(
                          ctx.sessionManager,
                          settings.maxInputBytes - 8192,
                      )
                    : null;
            if (
                current &&
                this.scope !== "global" &&
                sourceScope(current) !== this.scope
            )
                throw new MemoryUserError(
                    "The session source belongs to a different memory repository.",
                );
            const sources =
                mode === "current"
                    ? current
                        ? [current]
                        : []
                    : await this.scan(settings, signal, mode === "import");
            signal.throwIfAborted();
            return runPipeline({
                store: this.store,
                scope: this.scope,
                settings,
                settingsSnapshot,
                sources,
                signal,
                model: piMemoryModel(ctx),
                now: this.now,
                force: true,
                onJobChange: () => this.changed(),
                checkSource: (source, requestSignal) =>
                    source.id === this.sessionId
                        ? Promise.resolve(
                              isSameSource(
                                  currentSource(
                                      ctx.sessionManager,
                                      settings.maxInputBytes - 8192,
                                  ),
                                  source,
                              ),
                          )
                        : isSourceUnchanged(
                              source,
                              requestSignal,
                              settings.maxInputBytes - 8192,
                          ),
            });
        };
        const pending = execute();
        this.pending = pending;
        this.changed();
        try {
            // Failed jobs are on their job rows; other errors reach the caller.
            return await pending;
        } finally {
            if (this.pending === pending) {
                this.pending = undefined;
                this.operation = undefined;
            }
            this.changed();
        }
    }
    async saveSettings(settings: MemorySettings): Promise<void> {
        await this.cancel();
        this.store.saveSettings(this.scope, settings, this.now());
        this.heartbeat();
        this.prepareInjection();
        this.changed();
    }
    status(): object {
        const legacy = this.store.legacyMemories(this.cwd);
        return {
            ...this.store.status(this.scope),
            repository: this.repository
                ? this.access.describe(
                      this.repository,
                      this.repository.worktreeRoot,
                  )
                : null,
            legacy:
                legacy.scope === this.scope
                    ? null
                    : {
                          scope: legacy.scope,
                          records: legacy.records.length,
                          excludedSources: legacy.excludedSources,
                      },
            recall: this.evidence(),
            coordinator: {
                isLeader: this.coordinator.isLeader,
                workers: this.coordinator.workerCount,
            },
            isRunning: this.isRunning,
            lastError: this.lastError ?? null,
        };
    }
    async dispose(): Promise<void> {
        if (this.lifetime.signal.aborted) return;
        this.lifetime.abort();
        this.access.endRequest();
        clearTimeout(this.timer);
        try {
            // Every job settles before storage closes, so none writes to a closed database.
            await Promise.all([this.cancelCurrent(), this.coordinator.close()]);
            this.store.releaseActivity(this.owner);
        } finally {
            this.store.close();
        }
    }
}
