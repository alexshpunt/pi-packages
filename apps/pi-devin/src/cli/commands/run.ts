import { Effect, type Exit } from "effect";
import type { DevinClient } from "../../core/client.ts";
import type { JsonObject } from "../../core/types.ts";
import type { CLIOptions } from "../options.ts";
import type { CLIOutputLog } from "../services/output.ts";

/** What the request budget hook reports: requests used so far, the current stage and model. */
export interface RunProgress {
  modelCalls: number;
  stage: string;
  modelId: string;
}

/** One inference command run: its options, client, output, report and progress. */
export interface CommandRun {
  values: CLIOptions["values"];
  output: CLIOutputLog;
  client: DevinClient;
  limit: number;
  progress: RunProgress;
  report: JsonObject;
  stages: JsonObject[];
}

/** Records each finished stage in the report and as an event. */
export function recordResult(run: CommandRun, stage: string, result: JsonObject): Effect.Effect<void> {
  return Effect.suspend(() => {
    run.stages.push({ stage, ...result });
    return run.output.emit("response", { stage, ...result });
  });
}

export function streamText(run: CommandRun, delta: string): Effect.Effect<void> {
  return run.values.json ? run.output.emit("text_delta", { delta }) : run.output.text(delta);
}

/**
 * Like try/finally: `release` runs after the body ends in any way, including interruption, and sees how it ended.
 * A failing release replaces the body's result, as a throwing `finally` does.
 */
export function withRelease<A, E, R, E2, R2>(body: Effect.Effect<A, E, R>, release: (exit: Exit.Exit<A, E>) => Effect.Effect<void, E2, R2>): Effect.Effect<A, E | E2, R | R2> {
  return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const exit = yield* Effect.exit(restore(body));
    yield* release(exit);
    return yield* exit;
  }));
}
