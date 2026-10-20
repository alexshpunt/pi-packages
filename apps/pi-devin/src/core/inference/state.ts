export const MAX_STEP_INDEX = 2_147_483_647;

export interface StepState { nextStepIndex: number }

export function takeStep(state: StepState): number {
  if (state.nextStepIndex >= MAX_STEP_INDEX) throw new Error("The session step limit was exceeded.");
  return state.nextStepIndex++;
}
