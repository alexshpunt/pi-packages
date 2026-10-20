import { randomUUID } from "node:crypto";
import { awaitWithSignal } from "../core/protocol/transport.ts";

export const DEVIN_STATE_ENTRY = "pi-devin.state.v1";
export type ExecutionKind = "agent" | "pending" | "manual" | "tree" | "direct" | "recovered";
export interface DevinSessionState {
  version: 1;
  sessionId: string;
  ownerHash?: string;
  cascadeId: string;
  trajectoryId: string;
  nextStepIndex: number;
  execution?: { id: string; used: number; settled: boolean; kind: ExecutionKind };
}
export interface SessionBinding {
  getSessionId(): string;
  getBranch(): readonly { type: string; customType?: string; data?: unknown }[];
  append(data: DevinSessionState): void;
}
interface Execution {
  data: NonNullable<DevinSessionState["execution"]>;
  controller: AbortController;
  tail: Promise<void>;
  cleanups: Set<() => void>;
  activeRequests: number;
  hasStarted: boolean;
  nextIsRecovery: boolean;
  hasCheckpoint: boolean;
}
export interface RequestLease {
  signal: AbortSignal;
  executionId: string;
  cascadeId: string;
  trajectoryId: string;
  sessionId: string;
  stepIndex: number;
  isAuxiliary: boolean;
  isRecovery: boolean;
  consume(): void;
  addCleanup(cleanup: () => void): void;
  release(): void;
}
export class ModelBudgetError extends Error {
  constructor(limit: number) { super(`Used all ${limit} Devin model HTTP requests in the budget.`); this.name = "ModelBudgetError"; }
}

/** Value of `PI_DEVIN_MAX_MODEL_CALLS`. Defaults to 8; anything other than an integer from 1 to 100 stops the extension from loading. */
export function modelCallLimit(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new Error("PI_DEVIN_MAX_MODEL_CALLS must be an integer from 1 to 100.");
  return Number(value);
}
const cancelled = () => new DOMException("The previous Devin run ended.", "AbortError");
const isUUID = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

function restoreState(binding: SessionBinding): DevinSessionState {
  const sessionId = binding.getSessionId();
  const entry = [...binding.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === DEVIN_STATE_ENTRY);
  if (!entry) return { version: 1, sessionId, cascadeId: randomUUID(), trajectoryId: randomUUID(), nextStepIndex: 0 };
  const value = entry.data as DevinSessionState | undefined;
  if (!value || value.version !== 1 || typeof value.sessionId !== "string" || !isUUID(value.cascadeId) || !isUUID(value.trajectoryId)
    || !Number.isSafeInteger(value.nextStepIndex) || value.nextStepIndex < 0 || value.nextStepIndex > 2_147_483_647
    || (value.ownerHash !== undefined && !/^[a-f0-9]{64}$/.test(value.ownerHash))
    || (value.execution !== undefined && (!isUUID(value.execution.id) || !Number.isSafeInteger(value.execution.used)
      || value.execution.used < 0 || value.execution.used > 100 || typeof value.execution.settled !== "boolean"))) {
    throw new Error("The Devin session state is corrupt or an unsupported version. Start a new session.");
  }
  if (value.sessionId !== sessionId) return { version: 1, sessionId, cascadeId: randomUUID(), trajectoryId: randomUUID(), nextStepIndex: 0 };
  return structuredClone(value);
}

/** One instance owns one Pi runtime. It never builds its own tool or retry loop. */
export class DevinLifecycle {
  private binding?: SessionBinding;
  private state: DevinSessionState = { version: 1, sessionId: randomUUID(), cascadeId: randomUUID(), trajectoryId: randomUUID(), nextStepIndex: 0 };
  private execution?: Execution;
  private isClosed = false;
  private isAuxiliary = false;
  readonly maxModelCalls: number;
  constructor(maxModelCalls = 8) {
    if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 100) throw new Error("The Devin request budget must be between 1 and 100.");
    this.maxModelCalls = maxModelCalls;
  }
  snapshot(): DevinSessionState { return structuredClone(this.state); }
  /** Model requests of the running or last finished run. used is 0 when this session has no run yet. */
  budget(): { used: number; limit: number; isActive: boolean } {
    const execution = this.state.execution;
    return { used: execution?.used ?? 0, limit: this.maxModelCalls, isActive: execution !== undefined && !execution.settled };
  }
  private checkpoint(): void {
    if (this.binding && this.binding.getSessionId() !== this.state.sessionId) throw cancelled();
    this.binding?.append(structuredClone(this.state));
  }
  private activate(data: NonNullable<DevinSessionState["execution"]>, hasCheckpoint = false): Execution {
    this.state.execution = data;
    return this.execution = { data, controller: new AbortController(), tail: Promise.resolve(), cleanups: new Set(), activeRequests: 0, hasStarted: false, nextIsRecovery: false, hasCheckpoint };
  }
  attach(binding: SessionBinding): void {
    this.abort(cancelled());
    this.binding = binding;
    this.state = restoreState(binding);
    this.execution = undefined; this.isClosed = false; this.isAuxiliary = false;
    if (this.state.execution && !this.state.execution.settled) {
      this.activate({ ...this.state.execution, kind: "recovered" }, true);
    }
  }
  begin(kind: ExecutionKind): void {
    if (this.isClosed) throw cancelled();
    if (this.execution && !this.execution.data.settled) {
      if (kind === "agent" && ["pending", "recovered"].includes(this.execution.data.kind)) this.execution.data.kind = "agent";
      else if (kind === "agent" && ["manual", "tree", "direct"].includes(this.execution.data.kind) && this.execution.activeRequests === 0) this.finish();
      else return; // Retries and tool follow-up calls do not get a new budget.
      if (this.execution) return;
    }
    this.activate({ id: randomUUID(), used: 0, settled: false, kind });
  }
  agentStarted(): void {
    if (!this.execution) this.begin("agent");
    this.execution!.nextIsRecovery = this.execution!.hasStarted;
    this.execution!.hasStarted = true;
  }
  beforeCompaction(reason: "manual" | "threshold" | "overflow"): void {
    this.begin(reason === "manual" ? "manual" : "pending");
    this.isAuxiliary = true;
  }
  afterCompaction(reason: "manual" | "threshold" | "overflow"): void {
    this.isAuxiliary = false;
    if (reason === "manual" && this.execution?.data.kind === "manual") this.finish();
  }
  beforeTree(): void { this.begin("tree"); this.isAuxiliary = true; }
  finish(): void {
    if (!this.execution) return;
    this.execution.data.settled = true;
    this.abort(cancelled());
    if (this.execution.hasCheckpoint) this.checkpoint();
    this.execution = undefined; this.isAuxiliary = false;
  }
  abort(reason: unknown): void {
    const active = this.execution;
    if (!active) return;
    if (!active.controller.signal.aborted) active.controller.abort(reason);
    for (const cleanup of active.cleanups) { try { cleanup(); } catch { /* A cleanup error must not skip releasing other resources. */ } }
  }
  shutdown(): void {
    if (this.isClosed) return;
    this.abort(cancelled());
    // An unfinished budget stays in the checkpoint so a reload cannot reset the limit.
    this.isClosed = true;
  }
  treeChanged(): void {
    if (!this.binding) return;
    this.abort(cancelled());
    this.state = restoreState(this.binding);
    this.state.trajectoryId = randomUUID(); this.state.nextStepIndex = 0;
    this.state.execution = undefined; this.execution = undefined; this.isAuxiliary = false;
    if (this.state.ownerHash) this.checkpoint();
  }
  async acquire(ownerHash: string, callerSignal?: AbortSignal): Promise<RequestLease> {
    if (this.isClosed) throw cancelled();
    callerSignal?.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(ownerHash)) throw new Error("A verified Devin account scope is required.");
    if (this.state.ownerHash && this.state.ownerHash !== ownerHash) throw new Error("This Pi session is bound to a different Devin account or endpoint. Start a new session.");
    this.state.ownerHash = ownerHash;
    if (!this.execution) this.begin("direct");
    const active = this.execution!, state = this.state;
    const signal = AbortSignal.any([active.controller.signal, ...(callerSignal ? [callerSignal] : [])]);
    const previous = active.tail;
    let releaseQueue!: () => void;
    const completed = new Promise<void>((resolve) => { releaseQueue = resolve; });
    active.tail = previous.then(() => completed);
    let hasReleased = false, hasAcquired = false;
    const ownCleanups = new Set<() => void>();
    const clean = () => { for (const cleanup of ownCleanups) { try { cleanup(); } catch {} } };
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (this.execution !== active || this.state !== state || this.isClosed || (this.binding && this.binding.getSessionId() !== state.sessionId)) throw cancelled();
    };
    const release = () => {
      if (hasReleased) return;
      hasReleased = true;
      signal.removeEventListener("abort", clean);
      for (const cleanup of ownCleanups) { active.cleanups.delete(cleanup); try { cleanup(); } catch {} }
      if (hasAcquired) active.activeRequests--;
      releaseQueue();
    };
    try {
      await awaitWithSignal(previous, signal);
      assertCurrent();
      if (active.data.used >= this.maxModelCalls) throw new ModelBudgetError(this.maxModelCalls);
      if (state.nextStepIndex >= 2_147_483_647) throw new Error("The Devin step number limit was reached. Start a new session.");
      active.activeRequests++; hasAcquired = true;
      const stepIndex = state.nextStepIndex++;
      active.hasCheckpoint = true;
      this.checkpoint();
      signal.addEventListener("abort", clean, { once: true });
      const isAuxiliary = this.isAuxiliary;
      const isRecovery = !isAuxiliary && active.nextIsRecovery;
      if (!isAuxiliary) active.nextIsRecovery = false;
      return {
        signal, executionId: active.data.id, cascadeId: state.cascadeId, trajectoryId: state.trajectoryId,
        sessionId: state.sessionId, stepIndex,
        isAuxiliary, isRecovery,
        consume: () => {
          assertCurrent();
          if (active.data.used >= this.maxModelCalls) { const error = new ModelBudgetError(this.maxModelCalls); this.abort(error); throw error; }
          active.data.used++; this.checkpoint();
        },
        addCleanup: (cleanup) => {
          let hasCleaned = false;
          const once = () => { if (!hasCleaned) { hasCleaned = true; cleanup(); } };
          ownCleanups.add(once); active.cleanups.add(once); if (signal.aborted) once();
        },
        release,
      };
    } catch (error) { release(); throw error; }
  }
}
