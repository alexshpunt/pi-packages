import { Effect, Exit, FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { getModelByUID, selectModel } from "../../core/client.ts";
import { isAuthenticationError, type DevinFailure } from "../../core/errors.ts";
import { safeError } from "../../core/redaction.ts";
import { fromPlatformError } from "../../core/services/platform.ts";
import type { JsonObject } from "../../core/types.ts";
import { failWith } from "../../core/validation.ts";
import { runConversation } from "../conversation.ts";
import { loadImageFiles } from "../images.ts";
import { analyticsEvent, initializeClient } from "../initialization.ts";
import { positiveInteger } from "../options.ts";
import { addTool } from "../registered-tools.ts";
import { SessionStore } from "../services/sessions.ts";
import { StateFiles } from "../services/state-files.ts";
import { recordResult, streamText, withRelease, type CommandRun } from "./run.ts";

/** Analytics events wait in a batch and are sent once before and once after the conversation. */
function analyticsBatch(run: CommandRun) {
  let events: JsonObject[] = [];
  const flush = Effect.gen(function* () {
    if (!events.length || (yield* run.client.transport.isAuthenticationInvalid)) return;
    const batch = events;
    events = [];
    yield* run.client.analytics(batch).pipe(Effect.catch((error) => isAuthenticationError(error) ? Effect.fail(error)
      : run.output.emit("warning", { message: `Failed to send analytics events: ${safeError(error, run.output.secrets)}` })));
  });
  return { flush, push: (event: JsonObject) => Effect.sync(() => { events.push(event); }) };
}

export function chatCommand(run: CommandRun): Effect.Effect<void, DevinFailure, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | SessionStore | StateFiles> {
  return Effect.gen(function* () {
    const { values, output, client } = run;
    const fs = yield* FileSystem.FileSystem;
    const sessions = yield* SessionStore;
    const files = yield* StateFiles;
    const spawner = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
    const promptFile = values["prompt-file"];
    const prompt = promptFile ? yield* fs.readFileString(promptFile).pipe(Effect.mapError(fromPlatformError)) : values.prompt ?? "";
    const images = yield* loadImageFiles(values.image ?? []);
    if (!prompt.trim() && !images.length) return yield* failWith("chat requires --prompt, --prompt-file or --image.");
    const maxTokens = values["max-tokens"] ? yield* positiveInteger(values["max-tokens"], 0) : undefined;
    const onWarning = (message: string) => output.emit("warning", { message });
    const { state, release } = yield* sessions.open(run.progress.modelId, values.resume);
    yield* withRelease(Effect.gen(function* () {
      const initialized = yield* initializeClient(client, { expectedUserId: values["expect-user-id"], expectedOwnerHash: state.ownerHash, onWarning });
      const selected = values.model !== undefined ? yield* selectModel(initialized.models, values.model) : yield* getModelByUID(initialized.models, state.model);
      state.model = selected.id;
      state.ownerHash = yield* client.accountIdentityHash;
      run.progress.modelId = selected.id;
      Object.assign(run.report, { model: selected.id, status: initialized.status, auxiliary: initialized.auxiliary, selectedModel: selected, imageCount: images.length, sessionId: state.id });
      yield* output.emit("session", { id: state.id, resumed: Boolean(values.resume) });
      yield* output.emit("selected_model", { ...selected, note: "The default output limit is the model maximum. Free use and USD cost are not guaranteed." });
      const analyticsId = values["no-analytics"] ? undefined : yield* files.installationId;
      const analytics = analyticsBatch(run);
      const eventOptions = { installationId: analyticsId ?? "", model: selected.id };
      if (analyticsId) {
        if (!values.resume) yield* analytics.push(yield* analyticsEvent(client, "SESSION_CREATED", eventOptions));
        yield* analytics.push(yield* analyticsEvent(client, "USER_MESSAGE_SENT", eventOptions));
      }
      yield* analytics.flush;
      yield* withRelease(runConversation(client, state, initialized.models, {
        prompt, images, maxTokens, maxRounds: run.limit,
        tools: values["enable-add-tool"] ? [addTool] : [], generateTitle: !values["no-title"],
        beforeCall: (stage) => Effect.sync(() => { run.progress.stage = stage; }),
        onResult: (stage, result) => recordResult(run, stage, result),
        onText: (delta) => streamText(run, delta),
        onWarning,
        onCheckpoint: (current) => sessions.save(current),
        onTool: (name, isError) => Effect.gen(function* () {
          yield* output.emit("tool_result", { name, isError });
          if (analyticsId) {
            const event = yield* analyticsEvent(client, "AGENT_TOOL_CALLED", { ...eventOptions, toolName: name }).pipe(Effect.option);
            if (event._tag === "Some") yield* analytics.push(event.value);
          }
        }).pipe(Effect.provideContext(spawner)),
      }), (exit) => Exit.hasInterrupts(exit) ? Effect.void : analytics.flush);
    }), () => release);
  });
}
