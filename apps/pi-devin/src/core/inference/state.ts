import { Effect } from "effect";
import type { DevinError } from "../errors.ts";
import { failWith } from "../validation.ts";

export const MAX_STEP_INDEX = 2_147_483_647;

export interface StepState { nextStepIndex: number }

export function takeStep(state: StepState): Effect.Effect<number, DevinError> {
  return Effect.suspend(() => state.nextStepIndex >= MAX_STEP_INDEX ? failWith("The session step limit was exceeded.")
    : Effect.succeed(state.nextStepIndex++));
}
