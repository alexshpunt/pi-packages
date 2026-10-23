import { randomUUID } from "node:crypto";
import { Effect, Exit } from "effect";
import { makeCancellation, type Cancellation } from "../../../core/cancellation.ts";
import { Cancelled, ModelBudgetError, type DevinError, type DevinFailure } from "../../../core/errors.ts";
import { failWith } from "../../../core/validation.ts";
import { AdmissionLine, type AdmissionTicket } from "./admission.ts";
import { freshState, MAX_STEP_INDEX, restoreState } from "./state.ts";
import type { BudgetUsage, DevinSessionState, ExecutionKind, ExecutionState, RequestLease, SessionBinding } from "./types.ts";

interface Execution {
  data: ExecutionState;
  /** Ends the run's work with a reason: a finished run, an exhausted budget or an invalidated login. */
  cancellation: Cancellation;
  /** Requests of one run are admitted one at a time, in order. */
  admission: AdmissionLine;
  cleanups: Set<Effect.Effect<void>>;
  activeRequests: number;
  hasStarted: boolean;
  nextIsRecovery: boolean;
  hasCheckpoint: boolean;
}

const cancelled = () => new Cancelled({ message: "The previous Devin run ended." });
const runQuietly = (cleanup: Effect.Effect<void>) => Effect.catchCause(cleanup, () => Effect.void);

/** Value of `PI_DEVIN_MAX_MODEL_CALLS`. Defaults to 8; anything other than an integer from 1 to 100 stops the extension from loading. */
export function modelCallLimit(value: string | undefined): Effect.Effect<number | undefined, DevinError> {
  if (value === undefined || value === "") return Effect.succeed(undefined);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) return failWith("PI_DEVIN_MAX_MODEL_CALLS must be an integer from 1 to 100.");
  return Effect.succeed(Number(value));
}

/** Runs of one extension instance and its attached session. It never builds its own tool or retry loop. */
export class DevinLifecycle {
  private binding?: SessionBinding;
  private state: DevinSessionState = freshState(randomUUID());
  private execution?: Execution;
  private isClosed = false;
  private isAuxiliary = false;
  readonly maxModelCalls: number;

  private constructor(maxModelCalls: number) {
    this.maxModelCalls = maxModelCalls;
  }

  static make(maxModelCalls = 8): Effect.Effect<DevinLifecycle, DevinError> {
    if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 100) return failWith("The Devin request budget must be between 1 and 100.");
    return Effect.sync(() => new DevinLifecycle(maxModelCalls));
  }

  get snapshot(): Effect.Effect<DevinSessionState> {
    return Effect.sync(() => structuredClone(this.state));
  }

  /** Model requests of the running or last finished run. used is 0 when this session has no run yet. */
  get budget(): Effect.Effect<BudgetUsage> {
    return Effect.sync(() => {
      const execution = this.state.execution;
      return { used: execution?.used ?? 0, limit: this.maxModelCalls, isActive: execution !== undefined && !execution.settled };
    });
  }

  private checkpoint(): Effect.Effect<void, Cancelled> {
    return Effect.suspend(() => {
      if (this.binding && this.binding.getSessionId() !== this.state.sessionId) return Effect.fail(cancelled());
      this.binding?.append(structuredClone(this.state));
      return Effect.void;
    });
  }

  private activate(data: ExecutionState, hasCheckpoint = false): Execution {
    this.state.execution = data;
    return this.execution = {
      data, cancellation: makeCancellation(), admission: new AdmissionLine(), cleanups: new Set(),
      activeRequests: 0, hasStarted: false, nextIsRecovery: false, hasCheckpoint,
    };
  }

  attach(binding: SessionBinding): Effect.Effect<void, DevinError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.abort(cancelled());
      this.binding = binding;
      this.state = yield* restoreState(binding);
      this.execution = undefined; this.isClosed = false; this.isAuxiliary = false;
      if (this.state.execution && !this.state.execution.settled) this.activate({ ...this.state.execution, kind: "recovered" }, true);
    });
  }

  begin(kind: ExecutionKind): Effect.Effect<void, Cancelled> {
    return Effect.gen({ self: this }, function* () {
      if (this.isClosed) return yield* Effect.fail(cancelled());
      const current = this.execution;
      if (current && !current.data.settled) {
        if (kind === "agent" && ["pending", "recovered"].includes(current.data.kind)) current.data.kind = "agent";
        else if (kind === "agent" && ["manual", "tree", "direct"].includes(current.data.kind) && current.activeRequests === 0) yield* this.finish;
        else return; // Retries and tool follow-up calls do not get a new budget.
        if (this.execution) return;
      }
      this.activate({ id: randomUUID(), used: 0, settled: false, kind });
    });
  }

  get agentStarted(): Effect.Effect<void, Cancelled> {
    return Effect.gen({ self: this }, function* () {
      if (!this.execution) yield* this.begin("agent");
      const execution = this.execution!;
      execution.nextIsRecovery = execution.hasStarted;
      execution.hasStarted = true;
    });
  }

  beforeCompaction(reason: "manual" | "threshold" | "overflow"): Effect.Effect<void, Cancelled> {
    return Effect.andThen(this.begin(reason === "manual" ? "manual" : "pending"), Effect.sync(() => { this.isAuxiliary = true; }));
  }

  afterCompaction(reason: "manual" | "threshold" | "overflow"): Effect.Effect<void, Cancelled> {
    return Effect.suspend(() => {
      this.isAuxiliary = false;
      return reason === "manual" && this.execution?.data.kind === "manual" ? this.finish : Effect.void;
    });
  }

  get beforeTree(): Effect.Effect<void, Cancelled> {
    return Effect.andThen(this.begin("tree"), Effect.sync(() => { this.isAuxiliary = true; }));
  }

  get finish(): Effect.Effect<void, Cancelled> {
    return Effect.gen({ self: this }, function* () {
      const execution = this.execution;
      if (!execution) return;
      execution.data.settled = true;
      yield* this.abort(cancelled());
      if (execution.hasCheckpoint) yield* this.checkpoint();
      this.execution = undefined; this.isAuxiliary = false;
    });
  }

  /** Stops the run's waiting and running requests with the reason. A cleanup failure never skips releasing other resources. */
  abort(reason: DevinFailure): Effect.Effect<void> {
    return Effect.suspend(() => {
      const active = this.execution;
      if (!active) return Effect.void;
      active.cancellation.cancelUnsafe(reason);
      return Effect.forEach([...active.cleanups], runQuietly, { discard: true });
    });
  }

  get shutdown(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.isClosed) return Effect.void;
      // An unfinished budget stays in the checkpoint so a reload cannot reset the limit.
      return Effect.andThen(this.abort(cancelled()), Effect.sync(() => { this.isClosed = true; }));
    });
  }

  get treeChanged(): Effect.Effect<void, DevinError | Cancelled> {
    return Effect.gen({ self: this }, function* () {
      if (!this.binding) return;
      yield* this.abort(cancelled());
      this.state = yield* restoreState(this.binding);
      this.state.trajectoryId = randomUUID(); this.state.nextStepIndex = 0;
      this.state.execution = undefined; this.execution = undefined; this.isAuxiliary = false;
      if (this.state.ownerHash) yield* this.checkpoint();
    });
  }

  acquire(ownerHash: string): Effect.Effect<RequestLease, DevinFailure> {
    return Effect.gen({ self: this }, function* () {
      if (this.isClosed) return yield* Effect.fail(cancelled());
      if (!/^[a-f0-9]{64}$/.test(ownerHash)) return yield* failWith("A verified Devin account scope is required.");
      if (this.state.ownerHash && this.state.ownerHash !== ownerHash) return yield* failWith("This Pi session is bound to a different Devin account or endpoint. Start a new session.");
      this.state.ownerHash = ownerHash;
      if (!this.execution) yield* this.begin("direct");
      const active = this.execution!, state = this.state;
      const ownCleanups = new Set<Effect.Effect<void>>();
      let isCounted = false, hasReleased = false;
      let ticket: AdmissionTicket | undefined;
      const release = Effect.suspend(() => {
        if (hasReleased) return Effect.void;
        hasReleased = true;
        for (const cleanup of ownCleanups) active.cleanups.delete(cleanup);
        return Effect.forEach([...ownCleanups], runQuietly, { discard: true }).pipe(Effect.andThen(Effect.suspend(() => {
          if (isCounted) active.activeRequests--;
          return ticket ? ticket.leave : Effect.void;
        })));
      });
      const assertCurrent = Effect.suspend(() => {
        const reason = active.cancellation.reason();
        if (reason) return Effect.fail(reason);
        if (this.execution !== active || this.state !== state || this.isClosed || (this.binding && this.binding.getSessionId() !== state.sessionId)) return Effect.fail(cancelled());
        return Effect.void;
      });
      const admitted = Effect.gen({ self: this }, function* () {
        // Entered inside the effect whose exit releases it, so an interruption cannot leave the line blocked.
        ticket = active.admission.enter();
        yield* active.cancellation.guard(ticket.turn);
        yield* assertCurrent;
        if (active.data.used >= this.maxModelCalls) return yield* Effect.fail(new ModelBudgetError({ limit: this.maxModelCalls }));
        if (state.nextStepIndex >= MAX_STEP_INDEX) return yield* failWith("The Devin step number limit was reached. Start a new session.");
        active.activeRequests++; isCounted = true;
        const stepIndex = state.nextStepIndex++;
        active.hasCheckpoint = true;
        yield* this.checkpoint();
        const isAuxiliary = this.isAuxiliary;
        const isRecovery = !isAuxiliary && active.nextIsRecovery;
        if (!isAuxiliary) active.nextIsRecovery = false;
        const lease: RequestLease = {
          executionId: active.data.id, cascadeId: state.cascadeId, trajectoryId: state.trajectoryId,
          sessionId: state.sessionId, stepIndex, isAuxiliary, isRecovery,
          cancellation: active.cancellation,
          consume: Effect.gen({ self: this }, function* () {
            yield* assertCurrent;
            if (active.data.used >= this.maxModelCalls) {
              const error = new ModelBudgetError({ limit: this.maxModelCalls });
              yield* this.abort(error);
              return yield* Effect.fail(error);
            }
            active.data.used++;
            yield* this.checkpoint();
          }),
          addCleanup: (cleanup) => Effect.suspend(() => {
            let hasCleaned = false;
            const once = Effect.suspend(() => {
              if (hasCleaned) return Effect.void;
              hasCleaned = true;
              return cleanup;
            });
            ownCleanups.add(once); active.cleanups.add(once);
            return active.cancellation.isCancelled() ? runQuietly(once) : Effect.void;
          }),
          release,
        };
        return lease;
      });
      return yield* admitted.pipe(Effect.onExit((exit) => Exit.isSuccess(exit) ? Effect.void : release));
    });
  }
}
