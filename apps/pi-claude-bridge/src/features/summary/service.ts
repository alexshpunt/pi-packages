import { Cause, Context as ServiceContext, Effect, Exit, Layer, Scope, type Fiber } from "effect";
import type { IsolatedSummaryDependencies, IsolatedSummaryServices } from "./types.js";
import { fromPromise } from "../../adapters/effects.js";
import { acquireQueryMessages } from "../../adapters/claude/messages.js";
import { buildSummaryQueryOptions } from "../../adapters/claude/query-options.js";
import { effortForReasoning, thinkingForReasoning } from "../../adapters/claude/request-options.js";
import { loadConfig } from "../../adapters/storage/configuration.js";
import { claudeCodeModelId } from "../models/policy.js";
import { sessionCwdFor, summarySessionFor } from "../../adapters/pi/session-cwd.js";
import { toBridgeContext } from "../../adapters/pi/transcript.js";
import { updateUsage } from "../../adapters/pi/usage.js";
import { Diagnostics } from "../../diagnostics/service.js";
import { Errors } from "../../adapters/pi/error-mapping.js";
import { Prompts } from "../prompt/service.js";
import { Configuration } from "../../configuration/service.js";
import { ClaudeClient } from "../../adapters/claude/client.js";
import { StreamEvents } from "../../adapters/pi/stream-events.js";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { query } from "@anthropic-ai/claude-agent-sdk";

export function createIsolatedSummary(dependencies: IsolatedSummaryDependencies): IsolatedSummaryServices {
	const { lifetimeScope, diagnostics, errors, prompts, configuration, client, events } = dependencies;
	function isolatedStreamFn(model: Model<any>, originalContext: Context, options?: SimpleStreamOptions): Effect.Effect<AssistantMessageEventStream> {
		return Effect.gen(function* () {
			const stream = createAssistantMessageEventStream();
			const scope = Scope.forkUnsafe(lifetimeScope, "sequential");
			let fiber: Fiber.Fiber<void> | undefined;
			let sdkQuery: ReturnType<typeof query> | undefined;
			let wasAborted = false;
			const output = events.newAssistantOutput(model, "", "stop");
			const onAbort = () => {
				wasAborted = true;
				if (sdkQuery) {
					const current = sdkQuery;
					Effect.runSync(Effect.forkIn(
						fromPromise(() => current.interrupt()).pipe(Effect.catchCause(() => Effect.void)),
						scope, { startImmediately: true },
					));
					try { current.close(); } catch {}
				}
				fiber?.interruptUnsafe();
			};
			let hasReleased = false;
			const release = () => {
				if (hasReleased) return;
				hasReleased = true;
				options?.signal?.removeEventListener("abort", onAbort);
				try { sdkQuery?.close(); } catch {}
			};
			yield* Scope.addFinalizer(scope, Effect.sync(release));
			const work = Effect.gen(function* () {
				options?.signal?.throwIfAborted();
				const context = toBridgeContext(originalContext);
				const promptText = options?.cacheRetention === "none"
					? prompts.extractUserPrompt(context.messages)
					: prompts.extractIsolatedSummaryPrompt(context.messages);
				if (!promptText) throw new Error("runIsolatedSummary: one-off summary without a user prompt (last message is not user?)");
				const cwd = sessionCwdFor(options?.sessionId, summarySessionFor(options?.signal));
				const providerSettings = loadConfig(cwd).provider;
				const cliModel = claudeCodeModelId(model, configuration.longContextSettings);
				const effort = effortForReasoning(model, options?.reasoning);
				const thinking = thinkingForReasoning(model, options?.reasoning);
				diagnostics.debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} effort=${effort ?? "default"}${thinking?.type === "disabled" ? " thinking=disabled" : ""} promptLen=${promptText.length}`);
				sdkQuery = client.invokeQuery({
					prompt: promptText,
					options: buildSummaryQueryOptions({
						cwd, providerSettings, model, cliModel, reasoning: options?.reasoning,
						systemPrompt: context.systemPrompt, debugOptions: diagnostics.makeCliDebugOptions("compact-summary"),
					}),
				});
				if (options?.signal) {
					if (options.signal.aborted) onAbort();
					else options.signal.addEventListener("abort", onAbort, { once: true });
				}
				if (wasAborted) throw new Error("Operation aborted");
				let assistantText = "";
				let finalText = "";
				let errorText: string | undefined;
				let hasLoggedFirstEvent = false;
				const messages = yield* acquireQueryMessages(sdkQuery);
				while (true) {
					const next = yield* messages.next;
					if (next.done) break;
					const message = next.value;
					if (!hasLoggedFirstEvent) {
						diagnostics.debug(`compact summary: first event type=${message.type}`);
						hasLoggedFirstEvent = true;
					}
					if (wasAborted) break;
					if (message.type === "assistant") {
						if (message.message.usage) updateUsage(output, message.message.usage, model);
						for (const block of message.message.content ?? []) {
							if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
						}
					} else if (message.type === "result") {
						if (message.usage) updateUsage(output, message.usage, model);
						events.logServedContextWindow("compact summary", message, model);
						errorText = errors.resultErrorText(message);
						if (!errorText && message.subtype === "success") finalText = message.result || assistantText;
					}
				}
				if (wasAborted || options?.signal?.aborted) throw new Error("Operation aborted");
				const text = finalText || assistantText;
				if (errorText || !text.trim()) {
					output.stopReason = "error";
					output.errorMessage = errorText ?? "Claude Code summary returned empty text";
					diagnostics.debug(`compact summary: error ${output.errorMessage}`);
				} else {
					diagnostics.debug(`compact summary: done textLen=${text.length}`);
					output.content = [{ type: "text", text }];
				}
			});
			const program = work.pipe(
				Scope.provide(scope),
				Effect.onExit((exit) => Effect.sync(() => {
					try {
						if (Exit.isFailure(exit)) {
							const isAborted = wasAborted || options?.signal?.aborted === true;
							output.stopReason = isAborted ? "aborted" : "error";
							output.errorMessage = isAborted ? "Operation aborted" : errors.errorMessage(Cause.squash(exit.cause));
							diagnostics.debug("runIsolatedSummary threw; pushing terminal error", Cause.squash(exit.cause));
						}
						if (output.stopReason === "stop") stream.push({ type: "done", reason: "stop", message: output });
						else stream.push({ type: "error", reason: output.stopReason === "aborted" ? "aborted" : "error", error: output });
						stream.end();
					} finally { release(); }
				}).pipe(Effect.ensuring(Scope.close(scope, Exit.void)))),
				Effect.catchCause(() => Effect.void),
			);
			fiber = yield* Effect.forkIn(program, scope, { startImmediately: true });
			if (wasAborted) fiber.interruptUnsafe();
			return stream;
		});
	}
	return { isolatedStreamFn };
}

export class Summary extends ServiceContext.Service<Summary, IsolatedSummaryServices>()("claude-bridge/Summary") {}
export const SummaryLive = Layer.effect(Summary, Effect.gen(function* () {
	return createIsolatedSummary({
		lifetimeScope: yield* Scope.Scope,
		diagnostics: yield* Diagnostics, errors: yield* Errors, prompts: yield* Prompts,
		configuration: yield* Configuration, client: yield* ClaudeClient, events: yield* StreamEvents,
	});
}));
