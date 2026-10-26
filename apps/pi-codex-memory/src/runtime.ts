import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "./config.js";
import { piMemoryModel, runPipeline, type PipelineResult } from "./pipeline.js";
import { buildInjection, MemoryReader } from "./retrieval.js";
import { currentSource, isSameSource, isSourceUnchanged, scanSources, sourceScope, type MemoryExposure } from "./sources.js";
import { canonicalCwd, safeError } from "./safety.js";
import { MemoryStore } from "./store.js";
import { findRepository, type RepositoryLocation } from "./repositories.js";
import { RepositoryAccess } from "./repository-access.js";

/** Owns one Pi session's scheduler and cancellation, not the database's cross-process locks. */
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
    private timer: ReturnType<typeof setTimeout> | undefined;
    private operation: AbortController | undefined;
    private pending: Promise<PipelineResult> | undefined;
    private isBusy = false;
    private isManaging = false;
    private nextScanAtMs = 0;
    private lastError: string | undefined;
    private snapshot = "";
    private snapshotGeneration = -1;
    private injectedBytes = 0;
    private recallMarker: MemoryExposure | undefined;
    constructor(private ctx: ExtensionContext, readonly agentDir: string) {
        this.cwd = canonicalCwd(ctx.cwd);
        this.sessionId = ctx.sessionManager.getSessionId();
        this.store = new MemoryStore(join(agentDir, "pi-codex-memory"));
        this.repository = findRepository(this.cwd);
        if (this.repository) this.store.registerRepository(this.repository);
        this.scope = this.store.scopeFor(this.cwd);
        this.access = new RepositoryAccess(this.store, this.scope, this.lifetime.signal);
        this.reader = new MemoryReader(this.store, this.scope, scope => this.access.canRead(scope));
    }
    updateContext(ctx: ExtensionContext): void { this.ctx = ctx; }
    settings(): MemorySettings { return this.store.getSettings(this.scope); }
    get signal(): AbortSignal { return this.lifetime.signal; }
    start(): void {
        if ((this.ctx.mode !== "tui" && this.ctx.mode !== "rpc") || !this.ctx.sessionManager.getSessionFile()) return;
        if (this.repository) this.store.registerSessionDirectory(this.repository.scope, this.ctx.sessionManager.getSessionDir());
        this.store.prune(this.scope, this.settings(), Date.now());
        this.heartbeat(); this.schedule();
    }
    private heartbeat(): void {
        this.store.activity(this.scope, this.sessionId, this.owner, this.isBusy || !this.ctx.isIdle(), Date.now());
    }
    private schedule(): void {
        if (this.lifetime.signal.aborted) return;
        clearTimeout(this.timer);
        const delayMs = Math.min(30_000, this.settings().pollIntervalMs);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (this.lifetime.signal.aborted) return;
            try {
                this.store.prune(this.scope, this.settings(), Date.now());
                this.heartbeat();
                if (!this.isManaging && !this.isBusy && this.ctx.isIdle() && !this.pending && Date.now() >= this.nextScanAtMs && this.settings().generateMemories) {
                    this.nextScanAtMs = Date.now() + this.settings().pollIntervalMs;
                    void this.run("automatic").catch(error => { if (!this.lifetime.signal.aborted) this.lastError = safeError(error); });
                }
            } catch (error) { this.lastError = safeError(error); }
            this.schedule();
        }, delayMs);
        this.timer.unref();
    }
    isActive(): boolean { return !this.lifetime.signal.aborted; }
    setManaging(value: boolean): void { this.isManaging = value; }
    busy(): void { this.isBusy = true; this.operation?.abort(); this.heartbeat(); }
    /** Auto-compaction can resume the same run without before_agent_start, so request-local consent survives it. */
    compacted(): void { this.isBusy = false; this.heartbeat(); }
    settled(): void { this.compacted(); this.access.endRequest(); }
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
        this.store.prune(this.scope, settings, Date.now());
        // Corrections, forgetting, scope/config changes and expiry invalidate even an active turn.
        if (this.snapshotGeneration !== this.store.state(this.scope).generation) {
            this.snapshot = buildInjection(this.store, this.scope, settings);
            this.snapshotGeneration = this.store.state(this.scope).generation;
        }
        return this.snapshot;
    }
    /** One marker per request, plus one upgrade when foreign context follows local recall. */
    claimRecallMarker(exposure: MemoryExposure): boolean {
        if (this.recallMarker === "external" || this.recallMarker === exposure) return false;
        this.recallMarker = exposure; return true;
    }
    recordInjection(text: string): void { this.injectedBytes = Buffer.byteLength(text); }
    evidence() { return { injectedBytes: this.injectedBytes, ...this.reader.evidence() }; }
    async cancel(): Promise<void> {
        this.operation?.abort();
        try { await this.pending; } catch {}
    }
    async run(mode: "automatic" | "current" | "import" | "refresh"): Promise<PipelineResult> {
        if (this.pending) throw new Error("A memory job is already running.");
        if (this.isBusy || !this.ctx.isIdle()) throw new Error("Memory generation waits for the foreground agent to become idle.");
        const settings = this.settings();
        const settingsSnapshot = JSON.stringify(settings);
        if (!settings.generateMemories) throw new Error("Enable memory generation in /codex-memory settings first.");
        const operation = new AbortController();
        this.operation = operation;
        const signal = AbortSignal.any([operation.signal, this.lifetime.signal, ...(this.ctx.signal ? [this.ctx.signal] : [])]);
        const ctx = this.ctx;
        const execute = async () => {
            const current = mode === "current" ? currentSource(ctx.sessionManager, settings.maxInputBytes - 8192) : null;
            if (current && this.scope !== "global" && sourceScope(current) !== this.scope)
                throw new Error("The session source belongs to a different memory repository.");
            const sources = mode === "current" ? current ? [current] : [] : await scanSources({
                agentDir: this.agentDir, cwd: this.cwd, sessionDir: ctx.sessionManager.getSessionDir(),
                scope: this.scope, settings, signal, nowMs: Date.now(), allowUnmarked: mode === "import",
                sessionDirectories: this.repository ? this.store.repository(this.repository.scope)?.sessionDirectories : undefined,
                isCwdExcluded: this.scope === "global" ? undefined : cwd => this.store.selectsGlobal(cwd),
            });
            signal.throwIfAborted();
            return runPipeline({ store: this.store, scope: this.scope, settings, settingsSnapshot, sources, signal,
                model: piMemoryModel(ctx), force: mode !== "automatic",
                checkSource: (source, requestSignal) => source.id === this.sessionId
                    ? Promise.resolve(isSameSource(currentSource(ctx.sessionManager, settings.maxInputBytes - 8192), source))
                    : isSourceUnchanged(source, requestSignal, settings.maxInputBytes - 8192),
            });
        };
        const pending = execute(); this.pending = pending;
        try { const result = await pending; this.lastError = result.failed ? "Some memory jobs failed; inspect status and retry settings." : undefined; return result; }
        finally { if (this.pending === pending) { this.pending = undefined; this.operation = undefined; } }
    }
    async saveSettings(settings: MemorySettings): Promise<void> {
        await this.cancel(); this.store.saveSettings(this.scope, settings); this.prepareInjection();
    }
    status(): object {
        const legacy = this.store.legacyMemories(this.cwd);
        return { ...this.store.status(this.scope), repository: this.repository ? this.access.describe(this.repository, this.repository.worktreeRoot) : null, legacy: legacy.scope === this.scope ? null : { scope: legacy.scope, records: legacy.records.length, excludedSources: legacy.excludedSources },
        recall: this.evidence(), isRunning: !!this.pending, lastError: this.lastError ?? null };
    }
    async dispose(): Promise<void> {
        if (this.lifetime.signal.aborted) return;
        this.lifetime.abort(); this.access.endRequest(); clearTimeout(this.timer);
        try { await this.cancel(); this.store.releaseActivity(this.owner); }
        finally { this.store.close(); }
    }
}
