import { Context as ServiceContext, Effect, Layer } from "effect";
import type { SdkUsage, StreamEventsDependencies, StreamEventsServices } from "./types.js";
import { fromPromise } from "../effects.js";
import { Diagnostics } from "../../diagnostics/service.js";
import { ToolBridge } from "../../features/tool-bridge/service.js";
import { QueryContext } from "../../features/query/state.js";
import { rateLimitResponse } from "./rate-limit.js";
import { updateUsage } from "./usage.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

export function createStreamEvents({ diagnostics, tools }: StreamEventsDependencies): StreamEventsServices {
	function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
		return {
			role: "assistant",
			content: text ? [{ type: "text", text }] : [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason,
			...(errorMessage ? { errorMessage } : {}),
			timestamp: Date.now(),
		};
	}

	/** Reports to the call that owns the open stream, before its next event, as pi's own
	 *  providers do. A failing consumer must not end the turn it is observing. */
	function reportHeldRateLimit(c: QueryContext, model: Model<any>): Effect.Effect<void> {
		return Effect.gen(function* () {
			const info = c.heldRateLimit;
			const onResponse = c.currentOnResponse;
			if (!info || !c.currentPiStream || !onResponse) return;
			c.heldRateLimit = undefined;
			yield* fromPromise(async () => onResponse(rateLimitResponse(info), model)).pipe(
				Effect.catch((error) => Effect.sync(() => diagnostics.debug("rate limit: onResponse failed", error))),
			);
		});
	}

	// --- Usage helpers ---

	// The counter mapping lives in usage.ts; the debug line is this side's job, so every
	// call site logs the same way rather than three times over.
	function recordUsage(output: AssistantMessage, usage: SdkUsage, model: Model<any>): void {
		const { cachePct, reasoning } = updateUsage(output, usage, model);
		const reasoningText = reasoning == null ? "" : ` reasoning=${reasoning}`;
		diagnostics.debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`);
	}

	// Log the *served* context window reported by an SDK result message
	// (modelUsage[id].contextWindow), which can differ from the window pi
	// registered (model.contextWindow) when the runtime entitlement doesn't
	// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
	// The result message's modelUsage is otherwise discarded; this makes the
	// gap observable. See issue #18.
	function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
		const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
		if (!modelUsage) return;
		for (const [k, v] of Object.entries(modelUsage)) {
			diagnostics.debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
		}
	}

	// --- Provider helpers: misc ---

	function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
		switch (reason) {
			case "tool_use": return "toolUse";
			case "max_tokens": return "length";
			case "end_turn": default: return "stop";
		}
	}

	function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
		if (!input) return fallback;
		try { return JSON.parse(input); } catch { return fallback; }
	}

	// --- Provider: streaming function ---
	//
	// Push-based streaming with MCP tool bridge:
	// 1. streamSimple starts a query() and kicks off consumeQuery() in background
	// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
	// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
	//    blocks the generator naturally — no events arrive until resolved.
	// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
	//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
	//
	// Note: resetTurnState clears turnSawStreamEvent while the generator may still
	// have queued messages from the previous turn. This is safe because step 3 nulls
	// currentPiStream, so any leftover messages hit the `!c.currentPiStream` guard
	// in consumeQuery and are skipped before resetTurnState runs.

	const completedStreams = new WeakSet<object>();

	function markStreamComplete(stream: AssistantMessageEventStream | null): void {
		if (stream) completedStreams.add(stream as object);
	}

	function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext, options: SimpleStreamOptions | undefined): void {
		if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
			diagnostics.debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
		}
		c.currentPiStream = stream;
		c.currentOnResponse = options?.onResponse;
	}

	function ensureTurnStarted(c: QueryContext): void {
		if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
			c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
			c.turnStarted = true;
		}
	}

	function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
		if (!c.currentPiStream || !c.turnOutput) return;
		diagnostics.debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage})}`);
		if (!c.turnStarted) ensureTurnStarted(c);
		const stream = c.currentPiStream;
		if (c.turnOutput.stopReason === "error") {
			stream!.push({ type: "error", reason: "error", error: c.turnOutput });
		} else {
			const reason = stopReason === "length" ? "length" : "stop";
			stream!.push({ type: "done", reason, message: c.turnOutput });
		}
		markStreamComplete(stream);
		stream!.end();
		c.currentPiStream = null;
	}

	/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
	 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
	function processStreamEvent(
		message: SDKMessage,
		customToolNameToPi: Map<string, string>,
		model: Model<any>,
		c: QueryContext,
	): void {
		if (!c.currentPiStream || !c.turnOutput) return;
		c.turnSawStreamEvent = true;
		const event = (message as SDKMessage & { event: any }).event;

		if (event?.type === "message_start") {
			// A broken HTTP stream can get synthetic block/message stops without a
			// message_delta stop_reason. Those blocks also belong to the failed attempt.
			if (c.turnStreamOpen || c.hasUnconfirmedStreamContent) dropAbandonedStreamBlocks(c, `restreamed as ${event.message?.id}`);
			c.turnToolCallIds = [];
			c.turnStreamMessageId = event.message?.id;
			c.turnStreamOpen = true;
			c.hasUnconfirmedStreamContent = true;
			c.turnStreamBlockStart = c.turnBlocks.length;
			if (event.message?.usage) recordUsage(c.turnOutput, event.message.usage, model);
			return;
		}

		if (event?.type === "content_block_start") {
			ensureTurnStarted(c);
			if (event.content_block?.type === "text") {
				c.turnBlocks.push({ type: "text", text: "", index: event.index });
				c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
			} else if (event.content_block?.type === "thinking") {
				c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
				c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
			} else if (event.content_block?.type === "tool_use") {
				const piName = tools.piToolNameFor(event.content_block.name, customToolNameToPi);
				if (!piName) {
					diagnostics.debug(`processStreamEvent: skipping tool_use for unserved tool ${event.content_block.name} [${event.content_block.id}] — CC rejects it and retries`);
					return;
				}
				c.turnToolCallIds.push(event.content_block.id);
				c.turnBlocks.push({
					type: "toolCall", id: event.content_block.id,
					name: piName,
					arguments: (event.content_block.input as Record<string, unknown>) ?? {},
					partialJson: "", index: event.index,
				});
				c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
			} else {
				diagnostics.debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
			}
			return;
		}

		if (event?.type === "content_block_delta") {
			const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
			const block = c.turnBlocks[index];
			if (!block) return;
			if (event.delta?.type === "text_delta" && block.type === "text") {
				block.text += event.delta.text;
				c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
			} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
				block.thinking += event.delta.thinking;
				c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
			} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
				block.partialJson += event.delta.partial_json;
				block.arguments = parsePartialJson(block.partialJson, block.arguments);
				c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
			} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
				block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
			} else {
				diagnostics.debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
			}
			return;
		}

		if (event?.type === "content_block_stop") {
			const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
			const block = c.turnBlocks[index];
			if (!block) return;
			delete block.index;
			if (block.type === "text") {
				c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
			} else if (block.type === "thinking") {
				c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
			} else if (block.type === "toolCall") {
				c.turnSawToolCall = true;
				block.arguments = tools.mapToolArgs(
					block.name, parsePartialJson(block.partialJson, block.arguments),
				);
				delete block.partialJson;
				c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
			}
			return;
		}

		if (event?.type === "message_delta") {
			if (event.delta?.stop_reason) c.hasUnconfirmedStreamContent = false;
			c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
			if (event.usage) recordUsage(c.turnOutput, event.usage, model);
			return;
		}

		if (event?.type === "message_stop") {
			dropUnfinishedStreamBlocks(c, `message_stop for ${c.turnStreamMessageId}`);
			c.turnStreamOpen = false;
		}

		if (event?.type === "message_stop" && c.turnSawToolCall) {
			// Tool call complete — end this pi stream. The SDK will still yield an
			// assistant message for this turn, but currentPiStream=null causes
			// consumeQuery to skip it. The MCP handler blocks the generator until
			// pi delivers the tool result via the next streamSimple call.
			c.turnOutput.stopReason = "toolUse";
			const stream = c.currentPiStream;
			stream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
			markStreamComplete(stream);
			stream!.end();
			c.currentPiStream = null;

			// Cursor is updated by the next streamSimple call (tool result delivery path)
			// which sets cursor = context.messages.length with the post-tool-result context.
			return;
		}

		if (event?.type !== "message_stop" && event?.type !== "ping") {
			diagnostics.debug("processStreamEvent: unhandled event type", event?.type);
		}
	}

	/** Remove the blocks of the message that just stopped which never got their own
	 *  content_block_stop, because the stream was cut inside them. A tool call left
	 *  that way carries whatever JSON survived the cut — `{}` when no delta landed at
	 *  all — under an id Claude Code drops from its own conversation before resuming
	 *  the turn, so it will never dispatch that id and nothing could answer a result
	 *  keyed to it; pi would reject the call, and its result would sit unmatched while
	 *  the resumed call waited in a handler. A thinking block left that way has no
	 *  signature.
	 *
	 *  Per block rather than per message: Claude Code keeps the blocks that did
	 *  complete, tool calls included, and one it dispatched while pi was never told is
	 *  the same deadlock the other way round. Nothing here ends the pi turn — with no
	 *  finished tool call left the resume is more of this same turn, and a turn ended
	 *  here would leave the real call with no stream to arrive on. */
	function dropUnfinishedStreamBlocks(c: QueryContext, why: string): void {
		const dropped: string[] = [];
		for (let i = c.turnBlocks.length - 1; i >= c.turnStreamBlockStart; i--) {
			// `index` is deleted at content_block_stop, so it marks a block that never closed.
			if (c.turnBlocks[i].index === undefined) continue;
			dropped.push(`${c.turnBlocks[i].type}${c.turnBlocks[i].id ? `[${c.turnBlocks[i].id}]` : ""}`);
			c.turnBlocks.splice(i, 1);
		}
		if (!dropped.length) return;
		diagnostics.debug(`dropUnfinishedStreamBlocks: ${why}; dropped ${dropped.reverse().join(",")}`);
		c.turnToolCallIds = c.turnBlocks.filter((b: any) => b.type === "toolCall").map((b: any) => b.id);
		c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
	}

	/** Remove a failed attempt before Claude Code retries it. The SDK can omit
	 *  terminators or synthesize them without a message_delta stop_reason. Keeping
	 *  the attempt duplicates text, can replay unsigned thinking, and can leave a
	 *  tool call whose handler will never run.
	 *  The fallback then restarts those indices. pi's normal provider path tolerates that;
	 *  pi-agent-core's experimental harness frame encoder keys blocks by contentIndex and
	 *  rejects a repeated start, so it would need a change there to drive this provider. */
	function dropAbandonedStreamBlocks(c: QueryContext, why: string): void {
		const dropped = c.turnBlocks.splice(c.turnStreamBlockStart);
		diagnostics.debug(`dropAbandonedStreamBlocks: ${why}; dropped ${dropped.length} blocks from ${c.turnStreamMessageId} types=${dropped.map((b: any) => b.type).join(",")}`);
		c.turnToolCallIds = [];
		c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
		c.turnStreamOpen = false;
		c.hasUnconfirmedStreamContent = false;
	}

	// The SDK always yields `assistant` messages (completed content blocks) after streaming.
	// When stream_events already delivered the content, this is a no-op. But after
	// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
	// arrives before any stream_events, this is the primary content path. Must maintain
	// the same stream lifecycle as processStreamEvent — including ending the stream on
	// tool_use to prevent deadlock with the MCP handler.
	//
	// It is also the content path when a stream stalls: Claude Code drops it and asks
	// again without streaming ("Error streaming, falling back to non-streaming mode"),
	// and the answer arrives as one assistant message, under a new message id, with no
	// stream_events of its own. turnSawStreamEvent is already set by the dead stream,
	// so gating on it alone dropped that message: its tool calls never reached pi, CC
	// sat in the MCP handler waiting for their results, and the turn hung on "Working"
	// until the user aborted it.
	function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
		const assistantMsg = (message as any).message;
		if (!assistantMsg?.content || !c.turnOutput) return;
		// Claude Code reports API failures and its own quota/context notices as a
		// `<synthetic>` assistant message: a report, not model output. Streaming its text
		// pins the turn's output before the failure it describes, and a consumer that only
		// fails over before output commits (pi-model-fallback-alias) then cannot reach the
		// next provider. Keep the wording on the failed turn — the error event carries it —
		// but emit no events, so the turn still reads as a call that produced no output.
		// Issue #162.
		if (assistantMsg.model === "<synthetic>") {
			// The report can follow a stalled stream whose non-streaming retry also failed;
			// drop the abandoned partial blocks (unsigned thinking, a tool call CC will never
			// dispatch) the way the fallback path below would.
			if (c.turnSawStreamEvent && (c.turnStreamOpen || c.hasUnconfirmedStreamContent)) dropAbandonedStreamBlocks(c, "synthetic failure report");
			diagnostics.debug(`processAssistantMessage: <synthetic> message, keeping ${assistantMsg.content.length} block(s) off the stream`);
			for (const block of assistantMsg.content) {
				if (block.type === "text" && block.text) c.turnBlocks.push({ type: "text", text: block.text });
				else diagnostics.debug("processAssistantMessage: unhandled <synthetic> block type", block.type);
			}
			if (assistantMsg.usage && c.turnOutput) recordUsage(c.turnOutput, assistantMsg.usage, model);
			return;
		}
		if (c.turnSawStreamEvent) {
			// Same id was already delivered; a new id is CC's non-streaming fallback.
			// A synthetic stop without a terminal stop_reason is not confirmation:
			// the non-streaming fallback must replace that attempt too.
			const id = assistantMsg.id;
			if (!id || !c.turnStreamMessageId || id === c.turnStreamMessageId) return;
			if (c.turnStreamOpen || c.hasUnconfirmedStreamContent) dropAbandonedStreamBlocks(c, `non-streaming fallback ${id}`);
		}
		c.turnToolCallIds = [];
		diagnostics.debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
		for (const block of assistantMsg.content) {
			if (block.type === "text" && block.text) {
				ensureTurnStarted(c);
				c.turnBlocks.push({ type: "text", text: block.text });
				const idx = c.turnBlocks.length - 1;
				c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
				c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
				c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
			} else if (block.type === "thinking") {
				ensureTurnStarted(c);
				c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
				const idx = c.turnBlocks.length - 1;
				c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
				if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
				c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
			} else if (block.type === "tool_use") {
				const piName = tools.piToolNameFor(block.name, customToolNameToPi);
				if (!piName) {
					diagnostics.debug(`processAssistantMessage: skipping tool_use for unserved tool ${block.name} [${block.id}] — CC rejects it and retries`);
					continue;
				}
				ensureTurnStarted(c);
				c.turnSawToolCall = true;
				c.turnToolCallIds.push(block.id);
				c.turnBlocks.push({
					type: "toolCall", id: block.id,
					name: piName,
					arguments: tools.mapToolArgs(piName, block.input),
				});
				const idx = c.turnBlocks.length - 1;
				const toolBlock = c.turnBlocks[idx];
				c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
				c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
			} else {
				diagnostics.debug("processAssistantMessage: unhandled block type", block.type);
			}
		}
		if (assistantMsg.usage && c.turnOutput) recordUsage(c.turnOutput, assistantMsg.usage, model);

		// End the stream on tool_use, same as processStreamEvent's message_stop handler.
		if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
			c.turnOutput.stopReason = "toolUse";
			const stream = c.currentPiStream;
			stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
			markStreamComplete(stream);
			stream.end();
			c.currentPiStream = null;
		}
	}

	/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
	 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
	 *  an assistant message (completed blocks). On tool_use, the stream is ended by
	 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
	 *  and the MCP handler blocks the generator until pi delivers the tool result. */

	return {
		claimCurrentPiStream,
		reportHeldRateLimit,
		processStreamEvent,
		processAssistantMessage,
		ensureTurnStarted,
		finalizeCurrentStream,
		logServedContextWindow,
		markStreamComplete,
		newAssistantOutput,
	};
}

export class StreamEvents extends ServiceContext.Service<StreamEvents, StreamEventsServices>()("claude-bridge/StreamEvents") {}
export const StreamEventsLive = Layer.effect(StreamEvents, Effect.gen(function* () {
	const diagnostics = yield* Diagnostics;
	const tools = yield* ToolBridge;
	return createStreamEvents({ diagnostics, tools });
}));
