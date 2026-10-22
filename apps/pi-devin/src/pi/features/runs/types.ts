import type { Effect } from "effect";
import type { Cancellation } from "../../../core/cancellation.ts";
import type { DevinFailure } from "../../../core/errors.ts";

export type ExecutionKind = "agent" | "pending" | "manual" | "tree" | "direct" | "recovered";
export interface ExecutionState { id: string; used: number; settled: boolean; kind: ExecutionKind }

/** The `pi-devin.state.v1` session entry. Holds no token, fingerprint or message. */
export interface DevinSessionState {
  version: 1;
  sessionId: string;
  ownerHash?: string;
  cascadeId: string;
  trajectoryId: string;
  nextStepIndex: number;
  execution?: ExecutionState;
}

/** Pi's current session as the run service sees it: its ID, its branch entries and a way to append a state entry. */
export interface SessionBinding {
  getSessionId(): string;
  getBranch(): readonly { type: string; customType?: string; data?: unknown }[];
  append(data: DevinSessionState): void;
}

/** One admitted model request of a run. */
export interface RequestLease {
  executionId: string;
  cascadeId: string;
  trajectoryId: string;
  sessionId: string;
  stepIndex: number;
  isAuxiliary: boolean;
  isRecovery: boolean;
  /** Ends when the run is aborted, failing with its reason. */
  cancellation: Cancellation;
  /** Counts one model HTTP request against the run's budget. */
  consume: Effect.Effect<void, DevinFailure>;
  /** Runs once when the run is aborted or the lease is released. */
  addCleanup(cleanup: Effect.Effect<void>): Effect.Effect<void>;
  /** Idempotent. Lets the next request of the run in. */
  release: Effect.Effect<void>;
}

export interface BudgetUsage { used: number; limit: number; isActive: boolean }
