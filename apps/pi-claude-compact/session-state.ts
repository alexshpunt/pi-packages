import type { EngineResult } from "./engine.ts";

/** Claude Code's autocompact circuit breaker (Oon). */
export const FAILURE_LIMIT = 3;
/** Rapid refill: compaction needed again within fewer than this many turns (nIt)... */
export const RAPID_REFILL_TURNS = 3;
/** ...this many times in a row trips the breaker. */
export const RAPID_REFILL_LIMIT = 3;
/** Precompute stops rescheduling after this many counted failures. */
export const PRECOMPUTE_FAILURE_LIMIT = 3;

export interface RapidRefillState {
  compacted: boolean;
  turnCounter: number;
  consecutiveRapidRefills: number;
}

export interface PrecomputeJob {
  /** Latest compaction entry in the context when the job started (null before the first compaction). */
  anchorCompactionId: string | null;
  controller: AbortController;
  promise: Promise<EngineResult>;
  result: EngineResult | undefined;
  /** Projected content of the summarized entries when the job started (set once it succeeds). */
  fingerprint: string | undefined;
}

export interface SessionRuntime {
  // Claude Code keeps these per query (one user prompt): they reset when a Pi run settles.
  consecutiveFailures: number;
  failureBreakerNotified: boolean;
  rapid: RapidRefillState;
  /** A media-error recovery already ran in this run (Claude Code's hasAttemptedReactiveCompact). */
  mediaRecoveryAttempted: boolean;
  precompute: PrecomputeJob | undefined;
  precomputeFailures: number;
  compacting: boolean;
  thresholdErrorNotified: boolean;
  summaryModelNotified: boolean;
}

export function createSessionRuntime(): SessionRuntime {
  return {
    consecutiveFailures: 0,
    failureBreakerNotified: false,
    rapid: { compacted: false, turnCounter: 0, consecutiveRapidRefills: 0 },
    mediaRecoveryAttempted: false,
    precompute: undefined,
    precomputeFailures: 0,
    compacting: false,
    thresholdErrorNotified: false,
    summaryModelNotified: false,
  };
}

/** A new query starts with fresh compaction tracking (Claude Code's compactTracking: undefined). */
export function resetRunTracking(runtime: SessionRuntime): void {
  runtime.consecutiveFailures = 0;
  runtime.failureBreakerNotified = false;
  runtime.rapid = { compacted: false, turnCounter: 0, consecutiveRapidRefills: 0 };
  runtime.mediaRecoveryAttempted = false;
}

/** Drr: a compaction needed again within RAPID_REFILL_TURNS turns counts as a rapid refill. */
export function evaluateRapidRefill(state: RapidRefillState): { trip: boolean; consecutive: number } {
  const consecutive = state.compacted && state.turnCounter < RAPID_REFILL_TURNS ? state.consecutiveRapidRefills + 1 : 0;
  return { trip: consecutive >= RAPID_REFILL_LIMIT, consecutive };
}

export function discardPrecompute(runtime: SessionRuntime): void {
  runtime.precompute?.controller.abort();
  runtime.precompute = undefined;
}
