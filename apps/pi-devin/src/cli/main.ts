import { dirname, resolve } from "node:path";
import { Console, Effect, FileSystem } from "effect";
import { abortWith } from "../core/cancellation.ts";
import { makeDevinClient, selectModel } from "../core/client.ts";
import { failureDetails, type DevinFailure } from "../core/errors.ts";
import { safeError } from "../core/redaction.ts";
import { fromPlatformError } from "../core/services/platform.ts";
import type { JsonObject } from "../core/types.ts";
import { failWith } from "../core/validation.ts";
import { chatCommand } from "./commands/chat.ts";
import { checkCommand } from "./commands/check.ts";
import { loginCommand } from "./commands/login.ts";
import type { CommandRun, RunProgress } from "./commands/run.ts";
import { HELP } from "./help.ts";
import { CLILive, type CLIServices } from "./layer.ts";
import { parseCLIOptions, positiveInteger } from "./options.ts";
import { CLIOutput, type CLIOutputLog } from "./services/output.ts";
import { StateFiles } from "./services/state-files.ts";

const COMMANDS = ["login", "status", "models", "chat", "tool-roundtrip", "verify-live", "logout"];

function command(args: string[], output: CLIOutputLog): Effect.Effect<void, DevinFailure, CLIServices> {
  return Effect.gen(function* () {
    const files = yield* StateFiles;
    const { values, positionals } = yield* parseCLIOptions(args);
    const name = positionals[0];
    if (values.help || !name) return yield* Console.log(HELP);
    if (positionals.length !== 1 || !COMMANDS.includes(name)) return yield* failWith("Unknown command. See --help.");
    const loginEncoding = values["login-encoding"];
    if (loginEncoding !== undefined && loginEncoding !== "proto" && loginEncoding !== "json") return yield* failWith("--login-encoding must be proto or json.");
    if (name !== "login" && (values["api-server-url"] || values["webapp-url"] || loginEncoding || values["login-api-url"] || values["force-manual-token-flow"] || values["no-browser"])) return yield* failWith("Login endpoint and encoding options are only allowed with login.");
    if (values["expect-user-id"] && !["status", "chat", "verify-live"].includes(name)) return yield* failWith("--expect-user-id is only allowed with status/chat/verify-live.");
    if (name !== "chat" && (values.image?.length || values.resume || values["enable-add-tool"] || values["no-title"] || values["no-analytics"] || values["rest-server"] || values["max-model-calls"])) return yield* failWith("Image, session, tool and auxiliary request options are only for chat.");
    if (name === "logout") {
      yield* files.removeCredential;
      return yield* output.emit("logged_out", { serverTokenRevoked: false });
    }
    if (name === "login") {
      return yield* loginCommand({
        apiServerURL: values["api-server-url"], webappURL: values["webapp-url"], encoding: loginEncoding,
        devinAPIURL: values["login-api-url"], flow: values["force-manual-token-flow"] ? "manual" : undefined, noBrowser: values["no-browser"],
        timeoutMs: yield* positiveInteger(values["timeout-ms"], 300_000),
      });
    }
    const isInference = ["chat", "tool-roundtrip", "verify-live"].includes(name);
    if (isInference && !values["allow-model-calls"]) return yield* failWith("Inference uses quota. Pass --allow-model-calls explicitly.");
    if (values.prompt !== undefined && values["prompt-file"] !== undefined) return yield* failWith("--prompt and --prompt-file cannot be used together.");
    if (name === "verify-live" && values["max-tokens"]) return yield* failWith("verify-live uses fixed output limits of 128/512/512.");
    const limit = name === "chat" ? yield* positiveInteger(values["max-model-calls"], 8) : name === "tool-roundtrip" ? 2 : 3;
    if (limit > 100) return yield* failWith("The model HTTP request limit is at most 100.");
    const credential = yield* files.readCredential;
    yield* output.setSecret(credential.sessionToken);
    const timeoutMs = yield* positiveInteger(values["timeout-ms"], 90_000);
    yield* Effect.scoped(Effect.gen(function* () {
      const progress: RunProgress = { modelCalls: 0, stage: "initialization", modelId: values.model ?? "swe-2-medium" };
      const client = yield* makeDevinClient(credential, {
        profile: isInference ? "agent" : "standalone", restBaseURL: values["rest-server"], timeoutMs,
        onRequest: (attempt) => Effect.suspend(() => {
          if (!attempt.isMetered) return Effect.void;
          if (progress.modelCalls >= limit) return failWith("The inference request limit was reached.");
          progress.modelCalls++;
          if (output.report) output.report.modelCalls = progress.modelCalls;
          return output.emit("request", { stage: attempt.stage ?? progress.stage, model: attempt.modelUid ?? progress.modelId, modelCalls: progress.modelCalls, limit, attempt: attempt.attempt, method: attempt.path });
        }),
      });
      output.reportPath = values.output ?? (name === "verify-live" ? "results/live.json" : undefined);
      if (name === "status") {
        output.report = yield* client.status({ expectedUserId: values["expect-user-id"] });
        return yield* output.emit("status", output.report);
      }
      if (name === "models") {
        const models = yield* client.models;
        output.report = { count: models.length, models: values.model ? [yield* selectModel(models, values.model)] : models };
        return yield* output.emit("models", output.report);
      }
      const stages: JsonObject[] = [];
      const report: JsonObject = { startedAt: new Date().toISOString(), command: name, model: progress.modelId, streamContentType: "application/connect+proto", success: false, modelCalls: progress.modelCalls, stages };
      output.report = report;
      const run: CommandRun = { values, output, client, limit, progress, report, stages };
      if (name === "chat") yield* chatCommand(run);
      else yield* checkCommand(run, name as "tool-roundtrip" | "verify-live");
      run.report.success = true;
      run.report.completedAt = new Date().toISOString();
      yield* output.emit("complete", { success: true, modelCalls: progress.modelCalls });
    }));
  });
}

/** Saves the report, if any, after the command ends. A failed save is reported as its own error. */
function saveReport(output: CLIOutputLog): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.suspend(() => {
    const { report, reportPath } = output;
    if (!report || !reportPath) return Effect.void;
    const file = resolve(reportPath);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(dirname(file), { recursive: true }).pipe(Effect.mapError(fromPlatformError));
      yield* fs.writeFileString(file, output.serialized(report, 2) + "\n", { mode: 0o600 }).pipe(Effect.mapError(fromPlatformError));
      yield* output.emit("report_saved", { path: file });
    }).pipe(Effect.catch((error) => Effect.andThen(output.emit("error", { message: safeError(error, output.secrets) }), Effect.sync(() => { process.exitCode = 1; }))));
  });
}

export function cli(args: string[], signal: AbortSignal): Effect.Effect<void, never, CLIServices> {
  return Effect.flatMap(CLIOutput, (output) => command(args, output).pipe(
    abortWith(signal),
    Effect.catch((error) => Effect.gen(function* () {
      const message = safeError(error, output.secrets);
      const details = failureDetails(error);
      if (output.report) Object.assign(output.report, { success: false, error: message, errorDetails: details, completedAt: new Date().toISOString() });
      yield* output.emit("error", { message, ...details });
      process.exitCode = signal.aborted ? 130 : 1;
    })),
    Effect.ensuring(saveReport(output)),
  ));
}

export async function runCLI(args = process.argv.slice(2)): Promise<void> {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new DOMException("Cancelled by the user.", "AbortError"));
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try { await Effect.runPromise(cli(args, controller.signal).pipe(Effect.provide(CLILive))); }
  finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}
