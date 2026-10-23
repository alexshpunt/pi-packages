import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import type { DevinError } from "../../../core/errors.ts";
import { failWith } from "../../../core/validation.ts";
import type { DevinSessionState, SessionBinding } from "./types.ts";

export const DEVIN_STATE_ENTRY = "pi-devin.state.v1";
export const MAX_STEP_INDEX = 2_147_483_647;

const UUID = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
const isStoredState = Schema.is(Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  ownerHash: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  cascadeId: UUID,
  trajectoryId: UUID,
  nextStepIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_STEP_INDEX })),
  execution: Schema.optionalKey(Schema.Struct({ id: UUID, used: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })), settled: Schema.Boolean })),
}));

export function freshState(sessionId: string): DevinSessionState {
  return { version: 1, sessionId, cascadeId: randomUUID(), trajectoryId: randomUUID(), nextStepIndex: 0 };
}

/** The newest state of this session's branch. Another session's state starts fresh; a corrupt one stops instead of resetting the budget. */
export function restoreState(binding: SessionBinding): Effect.Effect<DevinSessionState, DevinError> {
  return Effect.suspend(() => {
    const sessionId = binding.getSessionId();
    const entry = [...binding.getBranch()].reverse().find((item) => item.type === "custom" && item.customType === DEVIN_STATE_ENTRY);
    if (!entry) return Effect.succeed(freshState(sessionId));
    if (!isStoredState(entry.data)) return failWith("The Devin session state is corrupt or an unsupported version. Start a new session.");
    if (entry.data.sessionId !== sessionId) return Effect.succeed(freshState(sessionId));
    return Effect.succeed(structuredClone(entry.data) as DevinSessionState);
  });
}
