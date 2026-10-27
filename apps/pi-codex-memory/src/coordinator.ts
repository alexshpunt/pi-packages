import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isMemoryEnabled, type MemorySettings } from "./config.js";
import {
    MemoryFailure,
    MemoryUserError,
    memoryFailureCode,
} from "./failure.js";
import { createStages, needsExtraction, piMemoryModel } from "./pipeline.js";
import { safeError } from "./safety.js";
import {
    ACTIVITY_TTL_MS,
    type JobLease,
    type MemoryStore,
    type RolloutSource,
} from "./store.js";

/** Sessions that become memory at once in one scope, as in Codex's extraction concurrency. */
export const WORKER_LIMIT = 8;
/** A gap this long between ticks means the computer slept, so other sessions' heartbeats may have lapsed. */
const STALL_MS = 60_000;

export interface CoordinatorHost {
    readonly store: MemoryStore;
    readonly scope: string;
    /** Identifies this Pi session's runtime in the coordinator lease. */
    readonly owner: string;
    /** Ends with the Pi session that hosts the coordinator. */
    readonly signal: AbortSignal;
    now(): number;
    /** Waits on the host clock; rejects when `signal` aborts. */
    sleep(ms: number, signal: AbortSignal): Promise<void>;
    context(): ExtensionContext;
    scan(
        settings: MemorySettings,
        signal: AbortSignal,
        shouldRead: (path: string, mtimeMs: number) => boolean,
    ): Promise<RolloutSource[]>;
    /** A memory menu is open, so settings may be about to change. */
    isPaused(): boolean;
    /** Jobs or errors changed, so the status may have changed. */
    changed(): void;
}

/** How a dispatch round ended: no waiting work left, every slot full, or the model unavailable. */
type DispatchResult = "done" | "full" | "blocked";
/** Outcomes counted for a manual run. */
export interface RunTally {
    extracted: number;
    failed: number;
}
/** The session-age range of one manual run; never saved as a setting. */
export type MemoryCreationRange = "recent" | "all";
/** A manual run claims waiting conversations even in retry backoff, but each only once. */
interface ManualRun {
    readonly scanSettings: MemorySettings;
    readonly claimed: Set<string>;
}

/** Pi names session files `<time>_<session id>.jsonl`. */
function sessionIdOf(path: string): string | undefined {
    return /_([A-Za-z0-9-]+)\.jsonl$/.exec(path)?.[1];
}

/**
 * Turns closed sessions into memory for one scope. Every open Pi session with memory on runs one,
 * but only the holder of the scope's coordinator lease scans and starts jobs; the others take
 * over when that session ends. Each closed session gets its own job, at most WORKER_LIMIT at once,
 * and the summary is updated once no job is left.
 *
 * Every job claims a lease in SQLite, so two coordinators, for example after the computer sleeps,
 * never process the same session twice, and late output after a lost lease is discarded. Jobs end
 * when the term that started them ends: on losing the lease, a settings change, Stop, or shutdown.
 *
 * Job failures are recorded on their job rows, where every session reads them; this class keeps
 * only errors outside jobs, such as a scan that could not read a file.
 */
export class MemoryCoordinator {
    readonly #host: CoordinatorHost;
    readonly #workers = new Map<string, Promise<void>>();
    #term = new AbortController();
    #isLeader = false;
    #settingsKey = "";
    /** Open sessions have marked themselves since the last settings change or sleep. */
    #readyAtMs = 0;
    /** A session that just took over waits one heartbeat period before its first scan. */
    #leadReadyAtMs = 0;
    #lastTickMs = 0;
    #nextScanMs = 0;
    #isConsolidating = false;
    #isManual = false;
    /** Counts every job that settles while a manual run is active, including scheduled ones. */
    #tally: RunTally | undefined;
    #round: Promise<void> | undefined;
    #tickError: string | undefined;
    #roundError: string | undefined;

    constructor(host: CoordinatorHost) {
        this.#host = host;
    }
    get isLeader(): boolean {
        return this.#isLeader;
    }
    get workerCount(): number {
        return this.#workers.size;
    }
    get isWorking(): boolean {
        return (
            this.#workers.size > 0 || this.#isConsolidating || this.#isManual
        );
    }
    get isConsolidating(): boolean {
        return this.#isConsolidating;
    }
    /** The last error outside a job; cleared by the next clean tick or round. */
    get error(): string | undefined {
        return this.#tickError ?? this.#roundError;
    }
    /**
     * Renews the lease and, when due, starts a scan. Runs on every heartbeat tick; never rejects.
     * Returns the scan it started so tests can wait for it.
     */
    tick(): Promise<void> {
        const { store, scope } = this.#host;
        if (this.#host.signal.aborted) return Promise.resolve();
        const nowMs = this.#host.now();
        try {
            const settings = store.getSettings(scope);
            if (!isMemoryEnabled(settings)) {
                // Turning memory on again is a settings change, not a sleep.
                this.#settingsKey = "";
                this.#lastTickMs = 0;
                this.#resign();
                this.#setTickError(undefined);
                return Promise.resolve();
            }
            const snapshot = this.#observe(
                settings,
                nowMs,
                this.#hasSlept(nowMs),
            );
            if (!store.lead(scope, this.#host.owner, nowMs)) {
                if (this.#isLeader) {
                    this.#isLeader = false;
                    this.#endTerm();
                }
                this.#setTickError(undefined);
                return Promise.resolve();
            }
            if (!this.#isLeader) {
                this.#isLeader = true;
                this.#leadReadyAtMs = nowMs + ACTIVITY_TTL_MS;
            }
            this.#setTickError(undefined);
            if (
                nowMs < Math.max(this.#readyAtMs, this.#leadReadyAtMs) ||
                nowMs < this.#nextScanMs ||
                this.#round ||
                this.#isManual ||
                this.#workers.size >= WORKER_LIMIT ||
                this.#host.isPaused()
            )
                return Promise.resolve();
            this.#nextScanMs = nowMs + settings.pollIntervalMs;
            return this.#track(
                this.#run(settings, snapshot, this.#term.signal),
            );
        } catch (error) {
            // A busy database or unreadable settings skips this tick; the lease covers two more.
            this.#setTickError(safeError(error));
            return Promise.resolve();
        }
    }
    /**
     * Turns closed conversations in the selected age range that are not memory yet into memory
     * now, without the idle wait and including conversations waiting to retry, then updates the
     * summary. Runs in this session whether or not it coordinates; job leases keep other sessions
     * from repeating its work. After a settings change or a sleep it waits one heartbeat period so open
     * sessions are not taken for closed. Stop, a settings change and shutdown end it.
     */
    async runNow(
        onWait?: (ms: number) => void,
        range: MemoryCreationRange = "recent",
    ): Promise<RunTally> {
        const { store, scope } = this.#host;
        if (this.#isManual)
            throw new MemoryUserError("Memories are already being created.");
        const settings = store.getSettings(scope);
        if (!isMemoryEnabled(settings))
            throw new MemoryUserError("Turn memory on in /codex-memory first.");
        const nowMs = this.#host.now();
        const snapshot = this.#observe(settings, nowMs, this.#hasSlept(nowMs));
        const signal = this.#term.signal;
        const tally: RunTally = { extracted: 0, failed: 0 };
        this.#isManual = true;
        this.#tally = tally;
        this.#host.changed();
        try {
            if (this.#readyAtMs > nowMs) {
                onWait?.(this.#readyAtMs - nowMs);
                await this.#host.sleep(this.#readyAtMs - nowMs, signal);
                // Ticks keep running during a real wait; this covers a wait no tick interrupted.
                this.#lastTickMs = this.#host.now();
            }
            while (this.#round) await this.#round;
            signal.throwIfAborted();
            const run = this.#manual(settings, snapshot, signal, tally, range);
            await this.#track(run.catch(() => {}));
            await run;
            return tally;
        } finally {
            this.#isManual = false;
            this.#tally = undefined;
            this.#host.changed();
        }
    }
    /** Stops running jobs; the next due scan starts them again. */
    async cancel(): Promise<void> {
        this.#endTerm();
        this.#nextScanMs = this.#host.now() + this.#pollIntervalMs();
        await this.#settled();
    }
    /** Stops every job, waits for it to settle, then gives up the lease. */
    async close(): Promise<void> {
        this.#endTerm();
        await this.#settled();
        this.#resign();
    }
    #pollIntervalMs(): number {
        try {
            return this.#host.store.getSettings(this.#host.scope)
                .pollIntervalMs;
        } catch {
            return 0;
        }
    }
    #hasSlept(nowMs: number): boolean {
        const hasSlept =
            this.#lastTickMs > 0 && nowMs - this.#lastTickMs >= STALL_MS;
        this.#lastTickMs = nowMs;
        return hasSlept;
    }
    async #settled(): Promise<void> {
        await Promise.allSettled([this.#round, ...this.#workers.values()]);
    }
    /**
     * Restarts the heartbeat period when settings or the scope selection changed, or after a long
     * gap: sessions that were off or asleep need one period to show they are open. The first
     * observation counts from when settings last changed. Jobs started under other settings would
     * be discarded, so they stop. Returns the settings snapshot.
     */
    #observe(
        settings: MemorySettings,
        nowMs: number,
        hasSlept: boolean,
    ): string {
        const { store, scope } = this.#host;
        const changedAtMs = store.epochChangedAt(scope);
        const snapshot = JSON.stringify(settings);
        // Edits and forgetting change the epoch too, but not heartbeats, so they are not in the key.
        const key = `${changedAtMs}:${snapshot}`;
        if (!this.#settingsKey && !hasSlept) {
            this.#readyAtMs = Math.min(nowMs, changedAtMs) + ACTIVITY_TTL_MS;
        } else if (key !== this.#settingsKey || hasSlept) {
            this.#endTerm();
            this.#readyAtMs = nowMs + ACTIVITY_TTL_MS;
            this.#nextScanMs = 0;
        }
        this.#settingsKey = key;
        return snapshot;
    }
    /** Keeps one round at a time; ticks start no other round until it settles. */
    #track(round: Promise<void>): Promise<void> {
        const tracked = round.finally(() => {
            if (this.#round === tracked) this.#round = undefined;
        });
        this.#round = tracked;
        return tracked;
    }
    #endTerm(): void {
        this.#term.abort();
        this.#term = new AbortController();
    }
    #resign(): void {
        if (
            this.#isLeader ||
            this.#workers.size ||
            this.#round ||
            this.#isManual
        )
            this.#endTerm();
        if (!this.#isLeader) return;
        this.#isLeader = false;
        this.#host.store.releaseLead(this.#host.owner);
    }
    #setTickError(error: string | undefined): void {
        if (this.#tickError === error) return;
        this.#tickError = error;
        this.#host.changed();
    }
    #setRoundError(error: string | undefined): void {
        if (this.#roundError === error) return;
        this.#roundError = error;
        this.#host.changed();
    }
    /** Cancellation and settings changes are not errors. */
    #isQuiet(error: unknown): boolean {
        const code = memoryFailureCode(error);
        return code === "aborted" || code === "superseded";
    }
    async #run(
        settings: MemorySettings,
        settingsSnapshot: string,
        signal: AbortSignal,
    ): Promise<void> {
        try {
            // The summary waits while conversations are waiting.
            const result = await this.#dispatch(
                settings,
                settingsSnapshot,
                signal,
            );
            if (result === "done" && !this.#workers.size)
                await this.#consolidate(
                    settings,
                    settingsSnapshot,
                    signal,
                    false,
                );
            this.#setRoundError(undefined);
        } catch (error) {
            if (!this.#isQuiet(error)) this.#setRoundError(safeError(error));
        }
    }
    /** Dispatches rounds until no closed conversation waits, ignoring the idle wait, then consolidates. */
    async #manual(
        settings: MemorySettings,
        settingsSnapshot: string,
        signal: AbortSignal,
        tally: RunTally,
        range: MemoryCreationRange,
    ): Promise<void> {
        const manual: ManualRun = {
            // Scan-only overrides: jobs and settings-change checks keep the saved settings.
            scanSettings: {
                ...settings,
                minIdleMs: 0,
                maxRolloutAgeDays:
                    range === "all"
                        ? Number.POSITIVE_INFINITY
                        : settings.maxRolloutAgeDays,
            },
            claimed: new Set(),
        };
        while (true) {
            const result = await this.#dispatch(
                settings,
                settingsSnapshot,
                signal,
                manual,
            );
            await Promise.allSettled([...this.#workers.values()]);
            signal.throwIfAborted();
            if (result === "blocked") {
                tally.failed++;
                return;
            }
            if (result === "done") break;
        }
        const consolidation = await this.#consolidate(
            settings,
            settingsSnapshot,
            signal,
            true,
        );
        if (consolidation.failed) tally.failed++;
    }
    /** A session file not modified since its memory was made has no new work, so it is not parsed. */
    #mayHaveWork(path: string, mtimeMs: number): boolean {
        const id = sessionIdOf(path);
        if (!id) return true;
        const succeededAt = this.#host.store.succeededAt(
            this.#host.scope,
            `extract:${id}`,
        );
        return succeededAt === undefined || mtimeMs > succeededAt;
    }
    async #dispatch(
        settings: MemorySettings,
        settingsSnapshot: string,
        signal: AbortSignal,
        manual?: ManualRun,
    ): Promise<DispatchResult> {
        const { store, scope } = this.#host;
        const now = () => this.#host.now();
        const force = !!manual;
        const sources = await this.#host.scan(
            manual?.scanSettings ?? settings,
            signal,
            (path, mtimeMs) => this.#mayHaveWork(path, mtimeMs),
        );
        const stages = createStages({
            store,
            scope,
            settings,
            settingsSnapshot,
            model: piMemoryModel(this.#host.context()),
            signal,
            now,
        });
        for (const source of sources) {
            signal.throwIfAborted();
            const key = `extract:${source.id}`;
            if (
                this.#workers.has(source.id) ||
                manual?.claimed.has(source.id) ||
                store.isSessionOpen(source.id, now()) ||
                !needsExtraction(store, scope, source, now()) ||
                !store.isClaimable(
                    scope,
                    key,
                    source.fingerprint,
                    now(),
                    settings,
                    force,
                )
            )
                continue;
            if (this.#workers.size >= WORKER_LIMIT) {
                // Fill freed slots at the next tick instead of waiting a full scan interval.
                this.#nextScanMs = 0;
                return "full";
            }
            // Every extraction uses the same model, so one failed check stops this round. The job
            // row records it, so every session shows the failure.
            if (
                !(await stages.isModelReady(
                    key,
                    source.fingerprint,
                    settings.extractModel,
                ))
            )
                return "blocked";
            // The session may have reopened while the model was checked.
            if (store.isSessionOpen(source.id, now())) continue;
            const lease = store.claim(
                scope,
                key,
                source.fingerprint,
                now(),
                settings,
                force,
            );
            if (!lease) continue;
            manual?.claimed.add(source.id);
            this.#start(source, lease, settings, settingsSnapshot, signal);
        }
        return "done";
    }
    #start(
        source: RolloutSource,
        lease: JobLease,
        settings: MemorySettings,
        settingsSnapshot: string,
        term: AbortSignal,
    ): void {
        const { store, scope } = this.#host;
        const controller = new AbortController();
        const signal = AbortSignal.any([term, controller.signal]);
        // Requests time out on their own; this bounds any other wait so no job outlives its term.
        const watchdog = setTimeout(
            () => controller.abort(new MemoryFailure("timeout")),
            settings.timeoutMs * 2 + 30_000,
        );
        watchdog.unref?.();
        const work = (async () => {
            let stages: ReturnType<typeof createStages>;
            try {
                stages = createStages({
                    store,
                    scope,
                    settings,
                    settingsSnapshot,
                    model: piMemoryModel(this.#host.context()),
                    signal,
                    now: () => this.#host.now(),
                });
            } catch (error) {
                store.fail(lease, this.#host.now(), 0, true, "superseded");
                throw error;
            }
            const outcome = await stages.extract(source, lease);
            if (outcome === "failed" && this.#tally) this.#tally.failed++;
            if (outcome === "extracted" && this.#tally) this.#tally.extracted++;
        })()
            .catch((error) => {
                if (!this.#isQuiet(error))
                    this.#setRoundError(safeError(error));
            })
            .finally(() => {
                clearTimeout(watchdog);
                this.#workers.delete(source.id);
                this.#host.changed();
            });
        this.#workers.set(source.id, work);
        this.#host.changed();
    }
    /** Updates the summary; `force` skips the interval, as for a manual run. */
    async #consolidate(
        settings: MemorySettings,
        settingsSnapshot: string,
        signal: AbortSignal,
        force: boolean,
    ): Promise<{ failed: boolean }> {
        const { store, scope } = this.#host;
        const state = store.state(scope);
        if (
            !force &&
            state.consolidatedAtMs &&
            this.#host.now() - state.consolidatedAtMs <
                settings.consolidationCooldownMs
        )
            return { failed: false };
        try {
            return await createStages({
                store,
                scope,
                settings,
                settingsSnapshot,
                model: piMemoryModel(this.#host.context()),
                signal,
                now: () => this.#host.now(),
            }).consolidate(force, () => {
                this.#isConsolidating = true;
                this.#host.changed();
            });
        } finally {
            if (this.#isConsolidating) {
                this.#isConsolidating = false;
                this.#host.changed();
            }
        }
    }
}
