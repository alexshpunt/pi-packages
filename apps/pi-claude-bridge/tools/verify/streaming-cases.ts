import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessageEvent, Context, Message, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fixtureUser } from "./harness.js";
import { withLiveRunner, type LiveRunner } from "./live.js";
import { fingerprint } from "./report.js";
import { expect, type CheckContext, type Facts } from "./types.js";

const longPrompt = "Without tools, output the numbers 1 through 600, one per line. Do not summarize or use ellipses.";
const textOf = (message: { content: unknown[] }) => message.content.flatMap(block => {
	const value = block as { type?: string; text?: string };
	return value.type === "text" ? [value.text ?? ""] : [];
}).join("");

/** Consume the real Pi event stream while the upstream SSE connection is open. */
async function observeTurn(
	runner: LiveRunner,
	context: Context,
	options: SimpleStreamOptions = {},
	onEvent?: (event: AssistantMessageEvent) => void,
) {
	const cleanup = new AbortController();
	const signal = AbortSignal.any([cleanup.signal, AbortSignal.timeout(90000), ...(options.signal ? [options.signal] : [])]);
	const sessionId = options.sessionId ?? runner.workspace.sessionId;
	const runtime = runner.harness.runtime;
	const stream = runtime.streamClaudeAgentSdk(runner.harness.model, context, { ...options, sessionId, signal });
	const execution = runtime.sessionQueryContexts.get(sessionId)?.execution;
	const events: string[] = [];
	let deltaCount = 0;
	let hasEarlyDelta = false;
	try {
		for await (const event of stream) {
			events.push(event.type);
			if (event.type === "text_delta") {
				deltaCount++;
				hasEarlyDelta ||= runner.requests.at(-1)?.isResponseComplete === false;
			}
			onEvent?.(event);
		}
		const answer = await stream.result();
		await runner.harness.waitForIdle();
		const deadlineMs = Date.now() + 10000;
		while (execution && execution.phase !== "closed" && Date.now() < deadlineMs) await delay(10);
		expect(!execution || execution.phase === "closed", "stream-query-scope-not-closed");
		for (const state of runtime.sessionQueryContexts.values()) {
			expect(state.pendingToolCalls.size === 0 && state.pendingResults.size === 0 && !state.promptStream && !state.bindRunSignal,
				"stream-query-state-not-released");
		}
		expect(events.filter(type => type === "done" || type === "error").length === 1, "stream-terminal-count-mismatch");
		expect(events.at(-1) === "done" || events.at(-1) === "error", "stream-event-after-terminal");
		if (deltaCount) expect(events.indexOf("start") >= 0 && events.indexOf("text_start") >= 0 &&
			events.indexOf("text_start") < events.indexOf("text_delta"), "stream-start-order-mismatch");
		if (answer.stopReason === "stop" && deltaCount) expect(events.filter(type => type === "text_start").length ===
			events.filter(type => type === "text_end").length && events.lastIndexOf("text_end") > events.lastIndexOf("text_delta"), "stream-blocks-not-balanced");
		return { answer, observed: { stopReason: answer.stopReason, deltaCount, hasEarlyDelta, terminalCount: 1, isScopeClosed: true, answer: fingerprint(textOf(answer)) } };
	} catch (error) {
		cleanup.abort();
		throw error;
	}
}

export async function streamingLifecycle(context: CheckContext): Promise<Facts> {
	return withLiveRunner(context, async runner => {
		const messages: Message[] = [fixtureUser(longPrompt)];
		const completed = await observeTurn(runner, { messages, tools: [] });
		expect(completed.answer.stopReason === "stop" && completed.observed.hasEarlyDelta && completed.observed.deltaCount > 1,
			"unbuffered-stream-not-observed", completed.observed);
		messages.push(completed.answer, fixtureUser(longPrompt));
		const controller = new AbortController();
		let hasCanceled = false;
		const canceled = await observeTurn(runner, { messages, tools: [] }, { signal: controller.signal }, event => {
			if (event.type === "text_delta" && !hasCanceled) { hasCanceled = true; controller.abort(); }
		});
		expect(hasCanceled && canceled.observed.hasEarlyDelta && canceled.answer.stopReason === "aborted" &&
			canceled.answer.errorMessage === "Operation aborted", "stream-cancellation-contract-failed", canceled.observed);
		messages.push(canceled.answer, fixtureUser("The previous output was canceled. Reply only STREAM_RECOVERY_OK without tools."));
		const recovered = await observeTurn(runner, { messages, tools: [] });
		expect(recovered.answer.stopReason === "stop" && textOf(recovered.answer).includes("STREAM_RECOVERY_OK"), "stream-recovery-failed");
		return { streaming: completed.observed, cancellation: canceled.observed, recovery: recovered.observed };
	}, 240000, undefined, undefined, undefined, { shouldStreamResponses: true });
}

export async function queryRecovery(context: CheckContext): Promise<Facts> {
	const sdkSequence: Facts[] = [];
	const messageIds = new Map<string, number>();
	const messageId = (id: string) => { if (!messageIds.has(id)) messageIds.set(id, messageIds.size + 1); return messageIds.get(id); };
	return withLiveRunner(context, async runner => {
		const memoryMarker = `RECOVERY-${randomUUID().slice(0, 8)}`;
		const messages: Message[] = [fixtureUser(`Remember ${memoryMarker}. Reply only READY without tools.`)];
		const seed = await observeTurn(runner, { messages, tools: [] });
		expect(seed.answer.stopReason === "stop", "recovery-seed-failed");
		messages.push(seed.answer, fixtureUser(longPrompt));
		let hasDisconnected = false;
		const disconnected = await observeTurn(runner, { messages, tools: [] }, {}, event => {
			if (event.type === "text_delta" && !hasDisconnected) { hasDisconnected = true; runner.disconnectResponses(); }
		});
		expect(hasDisconnected && disconnected.observed.hasEarlyDelta && ["error", "stop"].includes(disconnected.answer.stopReason),
			"connection-loss-not-exercised", disconnected.observed);
		// SDK versions may recover a dropped HTTP stream internally. Either a normal
		// failure or a completed SDK retry is valid, but never caller cancellation.
		if (disconnected.answer.stopReason === "stop") {
			const numbers = textOf(disconnected.answer).match(/^\d+$/gm) ?? [];
			expect(numbers.length === 600 && numbers.every((value, index) => Number(value) === index + 1), "connection-loss-returned-truncated-success", {
				...disconnected.observed, sdkSequence, numberCount: numbers.length, firstNumbers: numbers.slice(0, 6), lastNumbers: numbers.slice(-6),
				textBlocks: disconnected.answer.content.filter(block => block.type === "text").map(block => {
					const values = block.text.match(/\b\d+\b/g) ?? [];
					return { text: fingerprint(block.text), numberCount: values.length, firstNumbers: values.slice(0, 6), lastNumbers: values.slice(-6) };
				}),
			});
		}
		const afterDisconnect = runner.harness.runtime.sessionStateFor(runner.workspace.sessionId);
		if (disconnected.answer.stopReason === "error") expect(afterDisconnect?.needsRebuild, "connection-failure-not-marked-for-rebuild");
		messages.push(disconnected.answer, fixtureUser("After the interrupted output, reply only with the code I asked you to remember. Do not use tools."));
		const firstRecovery = await observeTurn(runner, { messages, tools: [] });
		expect(firstRecovery.answer.stopReason === "stop" && textOf(firstRecovery.answer).includes(memoryMarker), "connection-recovery-failed");
		messages.push(firstRecovery.answer, fixtureUser(longPrompt));
		runner.faultNextResult("process-exit");
		const exited = await observeTurn(runner, { messages, tools: [] });
		expect(exited.observed.hasEarlyDelta && exited.answer.stopReason === "error" && exited.answer.errorMessage !== "Operation aborted",
			"process-exit-not-an-ordinary-error", exited.observed);
		expect(runner.harness.runtime.sessionStateFor(runner.workspace.sessionId)?.needsRebuild, "process-exit-not-marked-for-rebuild");
		messages.push(exited.answer, fixtureUser("After the failed request, reply only with the code I asked you to remember. Do not use tools."));
		const secondRecovery = await observeTurn(runner, { messages, tools: [] });
		expect(secondRecovery.answer.stopReason === "stop" && textOf(secondRecovery.answer).includes(memoryMarker), "process-exit-recovery-failed");
		return { connectionLoss: disconnected.observed, connectionRecovery: firstRecovery.observed, processExit: exited.observed, processRecovery: secondRecovery.observed };
	}, 300000, undefined, undefined, undefined, { shouldStreamResponses: true, onSdkMessage(message) {
		if (message.type === "stream_event") {
			const event = message.event;
			if (event.type !== "content_block_delta") sdkSequence.push({ type: event.type,
				...(event.type === "message_start" ? { messageId: messageId(event.message.id) } : {}),
				...(event.type === "message_delta" ? { stopReason: event.delta.stop_reason } : {}) });
		} else if (message.type === "assistant") {
			sdkSequence.push({ type: message.type, messageId: messageId(message.message.id), stopReason: message.message.stop_reason,
				blocks: message.message.content.map(block => ({ type: block.type, ...(block.type === "text" ? { textBytes: Buffer.byteLength(block.text) } : {}) })) });
		} else if (message.type === "system" || message.type === "result") sdkSequence.push({ type: message.type, subtype: message.subtype });
	} });
}
