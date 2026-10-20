import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { credentialPath, readCredential } from "./credentials.ts";
import { DevinClient, getModelByUID, selectModel as resolveModel } from "../core/client.ts";
import { runConversation } from "./conversation.ts";
import { analyticsEvent, initializeClient, installationId } from "./initialization.ts";
import { loadImageFiles } from "./images.ts";
import { openSession, saveSession } from "./session-store.ts";
import { addTool } from "./registered-tools.ts";
import { failureDetails, isAuthenticationError, safeError } from "../core/protocol/transport.ts";
import { selectModel, textTurn, toolRoundtrip } from "./verification.ts";
import type { JsonObject } from "../core/types.ts";

import { HELP } from "./help.ts";
import { positiveInteger, parseCLIOptions } from "./options.ts";
import { loginCommand } from "./auth-command.ts";

export async function runCLI(args = process.argv.slice(2)): Promise<void> {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new DOMException("Cancelled by the user.", "AbortError"));
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  let secret = "";
  let report: JsonObject | undefined;
  let reportPath: string | undefined;
  let activeClient: DevinClient | undefined;

  function serialized(value: unknown, indent?: number): string {
    const text = JSON.stringify(value, null, indent);
    return secret ? text.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]") : text;
  }
  function emit(event: string, data: JsonObject = {}): void { console.log(serialized({ event, ...data })); }

  async function main(): Promise<void> {
    const { values, positionals } = parseCLIOptions(args);
    const command = positionals[0];
    if (values.help || !command) { console.log(HELP); return; }
    if (positionals.length !== 1 || !["login", "status", "models", "chat", "tool-roundtrip", "verify-live", "logout"].includes(command)) throw new Error("Unknown command. See --help.");
    const loginEncoding = values["login-encoding"];
    if (loginEncoding !== undefined && loginEncoding !== "proto" && loginEncoding !== "json") throw new Error("--login-encoding must be proto or json.");
    if (command !== "login" && (values["api-server-url"] || values["webapp-url"] || loginEncoding || values["login-api-url"] || values["force-manual-token-flow"] || values["no-browser"])) throw new Error("Login endpoint and encoding options are only allowed with login.");
    if (values["expect-user-id"] && !["status", "chat", "verify-live"].includes(command)) throw new Error("--expect-user-id is only allowed with status/chat/verify-live.");
    if (command !== "chat" && (values.image?.length || values.resume || values["enable-add-tool"] || values["no-title"] || values["no-analytics"] || values["rest-server"] || values["max-model-calls"])) throw new Error("Image, session, tool and auxiliary request options are only for chat.");
    if (command === "logout") {
      await rm(credentialPath(), { force: true });
      emit("logged_out", { serverTokenRevoked: false });
      return;
    }
    if (command === "login") {
      await loginCommand({
        apiServerURL: values["api-server-url"], webappURL: values["webapp-url"], encoding: loginEncoding,
        devinAPIURL: values["login-api-url"], flow: values["force-manual-token-flow"] ? "manual" : undefined, noBrowser: values["no-browser"],
        timeoutMs: positiveInteger(values["timeout-ms"], 300_000), signal: controller.signal,
      }, { emit, onCredential: (credential) => { secret = credential.sessionToken; } });
      return;
    }
    const isInference = ["chat", "tool-roundtrip", "verify-live"].includes(command);
    if (isInference && !values["allow-model-calls"]) throw new Error("Inference uses quota. Pass --allow-model-calls explicitly.");
    if (values.prompt !== undefined && values["prompt-file"] !== undefined) throw new Error("--prompt and --prompt-file cannot be used together.");
    if (command === "verify-live" && values["max-tokens"]) throw new Error("verify-live uses fixed output limits of 128/512/512.");
    const limit = command === "chat" ? positiveInteger(values["max-model-calls"], 8) : command === "tool-roundtrip" ? 2 : 3;
    if (limit > 100) throw new Error("The model HTTP request limit is at most 100.");
    let modelCalls = 0;
    let stage = "initialization";
    let modelId = values.model ?? "swe-2-medium";
    const credential = await readCredential();
    secret = credential.sessionToken;
    const client = new DevinClient(credential, {
      profile: isInference ? "agent" : "standalone", restBaseURL: values["rest-server"],
      timeoutMs: positiveInteger(values["timeout-ms"], 90_000),
      onRequest: (attempt) => {
        if (!attempt.isMetered) return;
        if (modelCalls >= limit) throw new Error("The inference request limit was reached.");
        modelCalls++;
        if (report) report.modelCalls = modelCalls;
        emit("request", { stage: attempt.stage ?? stage, model: attempt.modelUid ?? modelId, modelCalls, limit, attempt: attempt.attempt, method: attempt.path });
      },
    });
    activeClient = client;
    reportPath = values.output ?? (command === "verify-live" ? "results/live.json" : undefined);
    if (command === "status") {
      report = await client.status(controller.signal, values["expect-user-id"]);
      emit("status", report);
      return;
    }
    if (command === "models") {
      const models = await client.models(controller.signal);
      report = { count: models.length, models: values.model ? [resolveModel(models, values.model)] : models };
      emit("models", report);
      return;
    }
    const stages: JsonObject[] = [];
    report = { startedAt: new Date().toISOString(), command, model: modelId, streamContentType: "application/connect+proto", success: false, modelCalls, stages };
    const beforeCall = (nextStage: string) => { stage = nextStage; };
    const onResult = (resultStage: string, result: JsonObject) => {
      stages.push({ stage: resultStage, ...result });
      emit("response", { stage: resultStage, ...result });
    };
    const onText = (delta: string) => {
      if (values.json) emit("text_delta", { delta });
      else process.stderr.write(delta.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").split(secret).join("[REDACTED]"));
    };
    const onWarning = (message: string) => emit("warning", { message });

    if (command === "chat") {
      const prompt = values["prompt-file"] ? await readFile(values["prompt-file"], "utf8") : values.prompt ?? "";
      const images = await loadImageFiles(values.image ?? [], controller.signal);
      if (!prompt.trim() && !images.length) throw new Error("chat requires --prompt, --prompt-file or --image.");
      const maxTokens = values["max-tokens"] ? positiveInteger(values["max-tokens"], 0) : undefined;
      const { state, release } = await openSession(modelId, values.resume);
      try {
        const initialized = await initializeClient(client, {
          signal: controller.signal, expectedUserId: values["expect-user-id"], expectedOwnerHash: state.ownerHash, onWarning,
        });
        const selected = values.model !== undefined
          ? resolveModel(initialized.models, values.model)
          : getModelByUID(initialized.models, state.model);
        state.model = selected.id;
        state.ownerHash = client.accountIdentityHash;
        modelId = selected.id;
        report.model = modelId;
        report.status = initialized.status;
        report.auxiliary = initialized.auxiliary;
        report.selectedModel = selected;
        report.imageCount = images.length;
        report.sessionId = state.id;
        emit("session", { id: state.id, resumed: Boolean(values.resume) });
        emit("selected_model", { ...selected, note: "The default output limit is the model maximum. Free use and USD cost are not guaranteed." });
        const analyticsId = values["no-analytics"] ? undefined : await installationId();
        let events: JsonObject[] = [];
        const eventOptions = { installationId: analyticsId ?? "", model: modelId };
        const flush = async () => {
          if (!events.length || controller.signal.aborted || client.transport.isAuthenticationInvalid) return;
          const batch = events;
          events = [];
          try { await client.analytics(batch, controller.signal); }
          catch (error) {
            controller.signal.throwIfAborted();
            if (isAuthenticationError(error)) throw error;
            onWarning(`Failed to send analytics events: ${safeError(error, [secret])}`);
          }
        };
        if (analyticsId) {
          if (!values.resume) events.push(analyticsEvent(client, "SESSION_CREATED", eventOptions));
          events.push(analyticsEvent(client, "USER_MESSAGE_SENT", eventOptions));
        }
        await flush();
        try {
          await runConversation(client, state, initialized.models, {
            prompt, images, maxTokens, maxRounds: limit, signal: controller.signal,
            tools: values["enable-add-tool"] ? [addTool] : [], generateTitle: !values["no-title"],
            beforeCall, onResult, onText, onWarning, onCheckpoint: saveSession,
            onTool: (name, isError) => {
              emit("tool_result", { name, isError });
              if (analyticsId) events.push(analyticsEvent(client, "AGENT_TOOL_CALLED", { ...eventOptions, toolName: name }));
            },
          });
        } finally { await flush(); }
      } finally { await release(); }
    } else {
      const status = await client.status(controller.signal, values["expect-user-id"]);
      report.status = status;
      emit("status", status);
      if (status.canUseCli !== true) throw new Error("Could not confirm that this account may use the CLI.");
      if (status.dailyQuotaRemainingPercent === 0 || status.weeklyQuotaRemainingPercent === 0) throw new Error("The reported quota is 0, so no inference is run.");
      const models = await client.models(controller.signal);
      const selected = selectModel(models, modelId, true);
      report.catalogCount = models.length;
      report.selectedModel = selected;
      emit("selected_model", { ...selected, note: "costTier/creditMultiplier are advisory values; free use and USD cost are not guaranteed." });
      const common = { model: modelId, signal: controller.signal, beforeCall, onResult, onText };
      if (command === "verify-live") await textTurn(client, { ...common, prompt: "Reply with exactly: Hello from Devin PoC.", maxTokens: 128 });
      const maxTokens = positiveInteger(values["max-tokens"], 512);
      if (maxTokens > selected.maxOutputTokens) throw new Error("The requested output limit exceeds the model maximum.");
      const result = await toolRoundtrip(client, { ...common, maxTokens });
      report.toolResult = result.toolResult;
    }
    report.success = true;
    report.completedAt = new Date().toISOString();
    emit("complete", { success: true, modelCalls });
  }

  try { await main(); }
  catch (error) {
    const message = safeError(error, [secret]);
    const details = failureDetails(error);
    if (report) { report.success = false; report.error = message; report.errorDetails = details; report.completedAt = new Date().toISOString(); }
    emit("error", { message, ...details });
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    activeClient?.transport.close();
    if (report && reportPath) {
      try {
        const file = resolve(reportPath);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, serialized(report, 2) + "\n", { mode: 0o600 });
        emit("report_saved", { path: file });
      } catch (error) {
        emit("error", { message: safeError(error, [secret]) });
        process.exitCode = 1;
      }
    }
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}
