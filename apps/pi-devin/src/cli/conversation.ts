import { randomUUID } from "node:crypto";
import { Deferred, Effect, Fiber, Semaphore, type Scope } from "effect";
import type { DevinClient } from "../core/client.ts";
import type { DevinFailure } from "../core/errors.ts";
import { chatRequest, DEFAULT_SYSTEM_PROMPT, userMessage } from "../core/inference/request.ts";
import { withInferenceRetries, type InferenceRetryRuntime } from "../core/inference/retry.ts";
import { streamChat, summarizeChat } from "../core/inference/stream-chat.ts";
import { getModelByUID } from "../core/models/select.ts";
import { safeError } from "../core/redaction.ts";
import type { ChatMessage, ChatResult, ImageData, JsonObject, ModelInfo } from "../core/types.ts";
import { failWith } from "../core/validation.ts";
import { executeTools, type RegisteredTool } from "./registered-tools.ts";
import { takeStep, type SessionState } from "./services/sessions.ts";

const TITLE_MODEL_UID = "swe-1-6-fast";

export interface ConversationOptions {
  prompt: string;
  images?: ImageData[];
  maxTokens?: number;
  maxRounds?: number;
  tools?: RegisteredTool[];
  generateTitle?: boolean;
  systemPrompt?: string;
  retryRuntime?: InferenceRetryRuntime;
  beforeCall?: (stage: string) => Effect.Effect<void>;
  onText?: (delta: string) => Effect.Effect<void>;
  onResult?: (stage: string, result: JsonObject) => Effect.Effect<void>;
  onWarning?: (message: string) => Effect.Effect<void>;
  onCheckpoint?: (state: SessionState) => Effect.Effect<void, DevinFailure>;
  onTool?: (name: string, isError: boolean) => Effect.Effect<void>;
}

const observe = (effect: Effect.Effect<void> | undefined) => effect ?? Effect.void;

function assertCompleteTools(messages: readonly ChatMessage[]): Effect.Effect<void, DevinFailure> {
  const pending = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) pending.add(call.id);
    if (message.toolCallId) pending.delete(message.toolCallId);
  }
  return pending.size ? failWith("The session has unfinished tool calls. They are not rerun automatically to avoid duplicate execution.") : Effect.void;
}

/** Picks the model for this turn, asking a router for its assignment first. */
function assignTurnModel(client: DevinClient, state: SessionState, models: readonly ModelInfo[], user: ChatMessage, options: ConversationOptions) {
  return Effect.gen(function* () {
    const requested = yield* getModelByUID(models, state.model);
    if (!requested.isRouter) return { model: requested, assignmentJwt: undefined };
    yield* observe(options.beforeCall?.("assign-model-preview"));
    yield* client.assignModel(requested.id, state.cascadeId, undefined);
    yield* observe(options.beforeCall?.("assign-model"));
    const assignment = yield* client.assignModel(requested.id, state.cascadeId, user);
    const model = yield* getModelByUID(models, assignment.modelUid);
    if (model.isRouter) return yield* failWith("A router returned another router. It is not assigned again.");
    return { model, assignmentJwt: assignment.assignmentJwt };
  });
}

export function runConversation(client: DevinClient, state: SessionState, models: readonly ModelInfo[], options: ConversationOptions): Effect.Effect<ChatResult, DevinFailure> {
  return Effect.scoped(Effect.gen(function* () {
    yield* client.transport.assertAuthenticated;
    yield* assertCompleteTools(state.messages);
    if (!options.prompt.trim() && !options.images?.length) return yield* failWith("A prompt or an image is required.");
    const maxRounds = options.maxRounds ?? 8;
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 100) return yield* failWith("The model round limit must be between 1 and 100.");
    const user = userMessage(options.prompt, options.images);
    const { model, assignmentJwt } = yield* assignTurnModel(client, state, models, user, options);
    const hasImages = Boolean(options.images?.length || state.messages.some((message) => message.images?.length));
    if (hasImages && !model.supportsImages) return yield* failWith("The selected model does not support image input.");
    const tools = options.tools ?? [];
    if (tools.length && !model.supportsToolCalls) return yield* failWith("The selected model does not support tool calls.");
    const maxTokens = options.maxTokens ?? model.maxOutputTokens;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > model.maxOutputTokens) return yield* failWith("The output limit is outside the model maximum.");
    const executionId = randomUUID();
    const conversationScope: Scope.Scope = yield* Effect.scope;
    const secrets = [client.credential.sessionToken, assignmentJwt ?? ""];
    // Saves are serialized in call order.
    const saves = Semaphore.makeUnsafe(1);
    const checkpoint = saves.withPermits(1)(options.onCheckpoint?.(state) ?? Effect.void);
    state.messages.push(user);
    yield* checkpoint;

    const complete = (stage: string, messages: ChatMessage[], isAuxiliary: boolean, onDispatched?: Effect.Effect<void>) => {
      let hasDispatched = false;
      const request = (isRecovery: boolean) => Effect.gen(function* () {
        yield* observe(options.beforeCall?.(stage));
        const stepIndex = yield* takeStep(state);
        // The title starts on the primary's first dispatch and never waits for its own save.
        if (isAuxiliary) yield* Effect.forkIn(Effect.ignore(checkpoint), conversationScope);
        else yield* checkpoint;
        const titleModel = models.find((entry) => entry.id === TITLE_MODEL_UID);
        const titleLimit = titleModel?.maxOutputTokens || 128000;
        const body = chatRequest({
          metadata: yield* client.metadata(), model: isAuxiliary ? TITLE_MODEL_UID : model.id,
          messages, maxTokens: isAuxiliary ? Math.min(options.maxTokens ?? titleLimit, titleLimit) : maxTokens,
          cascadeId: state.cascadeId, trajectoryId: state.trajectoryId, clientSessionId: state.id,
          executionId, stepIndex, isAuxiliary, isRecovery, includeContext: !isAuxiliary, cwd: state.cwd,
          ...(isAuxiliary ? { systemPrompt: "Write a short descriptive title for the user's message. Return only the title." }
            : { systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, tools: tools.map((tool) => tool.definition), modelAssignmentJwt: assignmentJwt }),
        });
        const result = yield* streamChat(client.transport, body, {
          stage, onText: isAuxiliary ? undefined : options.onText,
          onDispatched: Effect.suspend(() => {
            if (hasDispatched || !onDispatched) return Effect.void;
            hasDispatched = true;
            return onDispatched;
          }),
        });
        yield* observe(options.onResult?.(stage, summarizeChat(result)));
        return result;
      });
      // Waits between attempts end with the client, for example when another request's 401 invalidates it.
      return client.transport.lifetime.guard(isAuxiliary ? request(false) : withInferenceRetries(request, {
        runtime: options.retryRuntime,
        onRetry: (event) => observe(options.onWarning?.(`${stage}: ${event.phase === "creation" ? "retrying stream start" : "recovering inference"} ${event.nextAttempt}/${event.limit}, waiting ${event.delayMs}ms`)),
      }));
    };

    let title: Fiber.Fiber<void> | undefined;
    const launchTitle = Effect.suspend(() => {
      if (options.generateTitle === false || state.hasTitleAttempted) return Effect.void;
      state.hasTitleAttempted = true;
      const dispatched = Deferred.makeUnsafe<void>();
      // Images are not sent again to the title generation model.
      const generate = complete("title", [userMessage(user.prompt || "Image input")], true, Deferred.succeed(dispatched, undefined).pipe(Effect.asVoid)).pipe(
        Effect.flatMap((result) => {
          state.title = result.message.prompt.trim().slice(0, 200);
          return checkpoint;
        }),
        Effect.catch((error) => observe(options.onWarning?.(`Skipped title generation: ${safeError(error, secrets)}`))),
        Effect.ensuring(Deferred.succeed(dispatched, undefined)),
      );
      // The title request leaves right after the primary one, before the primary's answer is read, as the CLI does.
      return Effect.gen(function* () {
        title = yield* Effect.forkIn(generate, conversationScope);
        yield* Deferred.await(dispatched);
      });
    });
    const awaitTitle = Effect.suspend(() => title ? Fiber.join(title) : Effect.void);

    // The title stops with the turn, and every queued save finishes before the turn returns.
    yield* Effect.addFinalizer(() => Effect.andThen(title ? Fiber.interrupt(title) : Effect.void, saves.withPermits(1)(Effect.void)));
    for (let round = 0; round < maxRounds; round++) {
      const result = yield* complete(round === 0 ? "chat" : "tool-followup", state.messages, false, round === 0 ? launchTitle : undefined);
      state.messages.push(result.message);
      yield* checkpoint;
      yield* awaitTitle;
      yield* client.transport.assertAuthenticated;
      const calls = result.message.toolCalls ?? [];
      if (calls.length === 0) {
        if (result.stopReason === "STOP_REASON_FUNCTION_CALL") return yield* failWith("No call matches the tool stop reason.");
        return result;
      }
      if (round + 1 >= maxRounds) return yield* failWith("The model round limit was reached; no more tools are executed.");
      const results = yield* executeTools(calls, tools, {
        allowParallel: model.supportsParallelToolCalls, secrets,
        onTool: (call, output) => observe(options.onTool?.(call.name, output.toolResultIsError === true)),
      });
      state.messages.push(...results);
      yield* checkpoint;
    }
    return yield* failWith("The model round limit was reached.");
  }));
}
