import { Effect } from "effect";
import { assertCanInfer } from "../../core/auth/access.ts";
import type { DevinFailure } from "../../core/errors.ts";
import { failWith } from "../../core/validation.ts";
import { positiveInteger } from "../options.ts";
import { selectModel, textTurn, toolRoundtrip } from "../verification.ts";
import { recordResult, streamText, type CommandRun } from "./run.ts";

/** `tool-roundtrip` and `verify-live`: bounded live checks without the conversation loop or its retries. */
export function checkCommand(run: CommandRun, command: "tool-roundtrip" | "verify-live"): Effect.Effect<void, DevinFailure> {
  return Effect.gen(function* () {
    const { values, output, client } = run;
    const status = yield* client.status({ expectedUserId: values["expect-user-id"] });
    run.report.status = status;
    yield* output.emit("status", status);
    yield* assertCanInfer(status);
    const models = yield* client.models;
    const selected = yield* selectModel(models, run.progress.modelId, true);
    run.report.catalogCount = models.length;
    run.report.selectedModel = selected;
    yield* output.emit("selected_model", { ...selected, note: "costTier/creditMultiplier are advisory values; free use and USD cost are not guaranteed." });
    const common = {
      model: run.progress.modelId,
      beforeCall: (stage: string) => Effect.sync(() => { run.progress.stage = stage; }),
      onResult: (stage: string, result: Record<string, unknown>) => recordResult(run, stage, result),
      onText: (delta: string) => streamText(run, delta),
    };
    if (command === "verify-live") yield* textTurn(client, { ...common, prompt: "Reply with exactly: Hello from Devin PoC.", maxTokens: 128 });
    const maxTokens = yield* positiveInteger(values["max-tokens"], 512);
    if (maxTokens > selected.maxOutputTokens) return yield* failWith("The requested output limit exceeds the model maximum.");
    const result = yield* toolRoundtrip(client, { ...common, maxTokens });
    run.report.toolResult = result.toolResult;
  });
}
