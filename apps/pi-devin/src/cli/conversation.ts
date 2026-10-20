import { randomUUID } from "node:crypto";
import { streamChat, chatRequest, summarizeChat, userMessage, DEFAULT_SYSTEM_PROMPT } from "../core/inference/chat.ts";
import { DevinClient, getModelByUID } from "../core/client.ts";
import { takeStep, type SessionState } from "./session-store.ts";
import { executeTools, type RegisteredTool } from "./registered-tools.ts";
import { safeError } from "../core/protocol/transport.ts";
import { withInferenceRetries, type InferenceRetryRuntime } from "../core/inference/retry.ts";
import type { ChatMessage, ChatResult, ImageData, JsonObject, ModelInfo } from "../core/types.ts";

const TITLE_MODEL_UID = "swe-1-6-fast";

export interface ConversationOptions {
  prompt: string;
  images?: ImageData[];
  maxTokens?: number;
  maxRounds?: number;
  tools?: RegisteredTool[];
  generateTitle?: boolean;
  systemPrompt?: string;
  signal?: AbortSignal;
  retryRuntime?: InferenceRetryRuntime;
  beforeCall?: (stage: string) => void;
  onText?: (delta: string) => void;
  onResult?: (stage: string, result: JsonObject) => void;
  onWarning?: (message: string) => void;
  onCheckpoint?: (state: SessionState) => Promise<void>;
  onTool?: (name: string, isError: boolean) => void;
}

function assertCompleteTools(messages: ChatMessage[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) pending.add(call.id);
    if (message.toolCallId) pending.delete(message.toolCallId);
  }
  if (pending.size) throw new Error("The session has unfinished tool calls. They are not rerun automatically to avoid duplicate execution.");
}

export async function runConversation(client: DevinClient, state: SessionState, models: ModelInfo[], options: ConversationOptions): Promise<ChatResult> {
  options.signal?.throwIfAborted();
  client.transport.assertAuthenticated();
  assertCompleteTools(state.messages);
  if (!options.prompt.trim() && !options.images?.length) throw new Error("A prompt or an image is required.");
  const maxRounds = options.maxRounds ?? 8;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 100) throw new Error("The model round limit must be between 1 and 100.");
  const user = userMessage(options.prompt, options.images);
  const requested = getModelByUID(models, state.model);
  let model = requested;
  let assignmentJwt: string | undefined;
  if (requested.isRouter) {
    options.beforeCall?.("assign-model-preview");
    await client.assignModel(requested.id, state.cascadeId, undefined, options.signal);
    options.beforeCall?.("assign-model");
    const assignment = await client.assignModel(requested.id, state.cascadeId, user, options.signal);
    model = getModelByUID(models, assignment.modelUid);
    if (model.isRouter) throw new Error("A router returned another router. It is not assigned again.");
    assignmentJwt = assignment.assignmentJwt;
  }
  const hasImages = Boolean(options.images?.length || state.messages.some((message) => message.images?.length));
  if (hasImages && !model.supportsImages) throw new Error("The selected model does not support image input.");
  const tools = options.tools ?? [];
  if (tools.length && !model.supportsToolCalls) throw new Error("The selected model does not support tool calls.");
  const maxTokens = options.maxTokens ?? model.maxOutputTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > model.maxOutputTokens) throw new Error("The output limit is outside the model maximum.");
  const executionId = randomUUID();
  const auxiliaryController = new AbortController();
  const auxiliarySignal = AbortSignal.any([auxiliaryController.signal, ...(options.signal ? [options.signal] : [])]);
  let checkpoints = Promise.resolve();
  const checkpoint = () => checkpoints = checkpoints.then(() => options.onCheckpoint?.(state));
  state.messages.push(user);
  await checkpoint();

  const complete = async (stage: string, messages: ChatMessage[], isAuxiliary = false, onDispatched?: () => void): Promise<ChatResult> => {
    const callerSignal = isAuxiliary ? auxiliarySignal : options.signal;
    const signal = AbortSignal.any([client.transport.abortSignal, ...(callerSignal ? [callerSignal] : [])]);
    let hasDispatched = false;
    const request = async (isRecovery = false): Promise<ChatResult> => {
      signal.throwIfAborted();
      options.beforeCall?.(stage);
      const stepIndex = takeStep(state);
      const saved = checkpoint();
      // Serializes saves and starts the title only on the primary's first dispatch.
      if (isAuxiliary) void saved.catch(() => {}); else await saved;
      const titleModel = models.find((entry) => entry.id === TITLE_MODEL_UID);
      const titleLimit = titleModel?.maxOutputTokens || 128000;
      const body = chatRequest({
        metadata: client.metadata(), model: isAuxiliary ? TITLE_MODEL_UID : model.id,
        messages, maxTokens: isAuxiliary ? Math.min(options.maxTokens ?? titleLimit, titleLimit) : maxTokens,
        cascadeId: state.cascadeId, trajectoryId: state.trajectoryId, clientSessionId: state.id,
        executionId, stepIndex, isAuxiliary, isRecovery, includeContext: !isAuxiliary, cwd: state.cwd,
        ...(isAuxiliary ? { systemPrompt: "Write a short descriptive title for the user's message. Return only the title." }
          : { systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, tools: tools.map((tool) => tool.definition), modelAssignmentJwt: assignmentJwt }),
      });
      const result = await streamChat(client.transport, body, { signal, stage, onText: isAuxiliary ? undefined : options.onText,
        onDispatched: () => { if (!hasDispatched) { hasDispatched = true; onDispatched?.(); } },
      });
      options.onResult?.(stage, summarizeChat(result));
      return result;
    };
    if (isAuxiliary) return request();
    return withInferenceRetries(request, {
      signal, runtime: options.retryRuntime,
      onRetry: (event) => options.onWarning?.(`${stage}: ${event.phase === "creation" ? "retrying stream start" : "recovering inference"} ${event.nextAttempt}/${event.limit}, waiting ${event.delayMs}ms`),
    });
  };

  let titleTask: Promise<void> | undefined;
  const launchTitle = () => {
    if (options.generateTitle === false || state.hasTitleAttempted) return;
    state.hasTitleAttempted = true;
    titleTask = (async () => {
      try {
        // Images are not sent again to the title generation model.
        const title = await complete("title", [userMessage(user.prompt || "Image input")], true);
        state.title = title.message.prompt.trim().slice(0, 200);
        await checkpoint();
      } catch (error) {
        if (!auxiliarySignal.aborted) options.onWarning?.(`Skipped title generation: ${safeError(error, [client.credential.sessionToken, assignmentJwt ?? ""])}`);
      }
    })();
  };

  try {
  for (let round = 0; round < maxRounds; round++) {
    const result = await complete(round === 0 ? "chat" : "tool-followup", state.messages, false, round === 0 ? launchTitle : undefined);
    state.messages.push(result.message);
    await checkpoint();
    await titleTask;
    options.signal?.throwIfAborted();
    client.transport.assertAuthenticated();
    const calls = result.message.toolCalls ?? [];
    if (calls.length === 0) {
      if (result.stopReason === "STOP_REASON_FUNCTION_CALL") throw new Error("No call matches the tool stop reason.");
      return result;
    }
    if (result.stopReason !== "STOP_REASON_FUNCTION_CALL") throw new Error("Incomplete tool requests are not executed.");
    if (round + 1 >= maxRounds) throw new Error("The model round limit was reached; no more tools are executed.");
    const results = await executeTools(calls, tools, {
      signal: options.signal, allowParallel: model.supportsParallelToolCalls,
      secrets: [client.credential.sessionToken, assignmentJwt ?? ""],
      onTool: (call, output) => options.onTool?.(call.name, output.toolResultIsError === true),
    });
    state.messages.push(...results);
    await checkpoint();
  }
  throw new Error("The model round limit was reached.");
  } finally {
    auxiliaryController.abort();
    await titleTask;
    await checkpoints;
  }
}
