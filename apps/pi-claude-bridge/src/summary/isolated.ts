import { buildSummaryQueryOptions } from "../cc/query-options.js";
import { effortForReasoning } from "../cc/request-options.js";
import { thinkingForReasoning } from "../cc/request-options.js";
import { loadConfig } from "../config.js";
import { claudeCodeModelId } from "../models.js";
import { sessionCwdFor } from "../session-cwd.js";
import { summarySessionFor } from "../session-cwd.js";
import { toBridgeContext } from "../transcript.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { BridgeRuntime } from "../runtime.js";



export interface IsolatedSummaryServices {
	readonly isolatedStreamFn: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
}

export function createIsolatedSummary(runtime: Pick<BridgeRuntime, "debug" | "errorMessage" | "extractIsolatedSummaryPrompt" | "extractUserPrompt" | "invokeQuery" | "logServedContextWindow" | "longContextSettings" | "makeCliDebugOptions" | "newAssistantOutput" | "resultErrorText">): IsolatedSummaryServices {
	function isolatedStreamFn(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		void runIsolatedSummary(model, context, options, stream);
		return stream;
	}

	async function runIsolatedSummary(
		model: Model<any>,
		context: Context,
		options: SimpleStreamOptions | undefined,
		stream: AssistantMessageEventStream,
	): Promise<void> {
		// pi delivers compaction/branch-summary requests as a transcript: the summarization
		// prompt folded into a leading system message ahead of the lone user message
		// (issue #106). toBridgeContext restores the prompt/tools fields the extraction
		// assertion below assumes; the summarization prompt still reaches CC as its systemPrompt.
		context = toBridgeContext(context);
		let sdkQuery: ReturnType<typeof query> | undefined;
		let wasAborted = false;
		const onAbort = () => {
			wasAborted = true;
			void sdkQuery?.interrupt().catch(() => {});
			try { sdkQuery?.close(); } catch {}
		};

		try {
			// One-off summarizer calls (compaction, branch summary, turn prefix, bug report —
			// anything routed through pi's completeSummarization) are marked cacheRetention:
			// "none". Any of them may appear in a future pi release without a bridge change,
			// so route on the marker, not on which summarizer is calling. Non-summarizer calls
			// must still match the [system,user] compaction shape exactly.
			const isOneOffSummary = options?.cacheRetention === "none";
			const promptText = isOneOffSummary
				? runtime.extractUserPrompt(context.messages)
				: runtime.extractIsolatedSummaryPrompt(context.messages);
			if (!promptText) throw new Error("runIsolatedSummary: one-off summary without a user prompt (last message is not user?)");
			const cwd = sessionCwdFor(options?.sessionId, summarySessionFor(options?.signal));
			const compactProviderSettings = loadConfig(cwd).provider;
			const cliModel = claudeCodeModelId(model, runtime.longContextSettings);
			// Honour the caller's reasoning level, same mapping as the provider path.
			const effort = effortForReasoning(model, options?.reasoning);
			const thinking = thinkingForReasoning(model, options?.reasoning);
			runtime.debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} effort=${effort ?? "default"}${thinking?.type === "disabled" ? " thinking=disabled" : ""} promptLen=${promptText.length}`);

			sdkQuery = runtime.invokeQuery({
				prompt: promptText,
				options: buildSummaryQueryOptions({
					cwd, providerSettings: compactProviderSettings, model, cliModel,
					reasoning: options?.reasoning, systemPrompt: context.systemPrompt,
					debugOptions: runtime.makeCliDebugOptions("compact-summary"),
				}),
			});

			if (options?.signal) {
				if (options.signal.aborted) onAbort();
				else options.signal.addEventListener("abort", onAbort, { once: true });
			}

			let assistantText = "";
			let finalText = "";
			let errorText: string | undefined;
			let firstEventLogged = false;

			for await (const message of sdkQuery) {
				if (!firstEventLogged) {
					runtime.debug(`compact summary: first event type=${message.type}`);
					firstEventLogged = true;
				}
				if (wasAborted) break;

				if (message.type === "assistant") {
					for (const block of (message as any).message?.content ?? []) {
						if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
					}
				} else if (message.type === "result") {
					runtime.logServedContextWindow("compact summary", message, model);
					errorText = runtime.resultErrorText(message);
					if (!errorText && message.subtype === "success") finalText = message.result || assistantText;
				}
			}

			if (wasAborted) {
				const output = runtime.newAssistantOutput(model, "", "aborted", "Operation aborted");
				runtime.debug("compact summary: aborted");
				stream.push({ type: "error", reason: "aborted", error: output });
				stream.end();
				return;
			}

			const text = finalText || assistantText;
			if (errorText || !text.trim()) {
				const msg = errorText ?? "Claude Code summary returned empty text";
				runtime.debug(`compact summary: error ${msg}`);
				stream.push({ type: "error", reason: "error", error: runtime.newAssistantOutput(model, "", "error", msg) });
				stream.end();
				return;
			}

			runtime.debug(`compact summary: done textLen=${text.length}`);
			stream.push({ type: "done", reason: "stop", message: runtime.newAssistantOutput(model, text, "stop") });
			stream.end();
		} catch (err) {
			const msg = runtime.errorMessage(err);
			runtime.debug("runIsolatedSummary threw; pushing terminal error", err);
			stream.push({ type: "error", reason: "error", error: runtime.newAssistantOutput(model, "", "error", msg) });
			stream.end();
		} finally {
			options?.signal?.removeEventListener("abort", onAbort);
			try { sdkQuery?.close(); } catch {}
		}
	}

	return {
		isolatedStreamFn,
	};
}
