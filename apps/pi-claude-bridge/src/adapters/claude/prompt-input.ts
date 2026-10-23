import { Deferred, Effect } from "effect";
import type { PromptStream } from "./types.js";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export function makePromptStream(): PromptStream {
	type Item = { message: SDKUserMessage; ack: Deferred.Deferred<void, Error> };
	const queue: Item[] = [];
	let inflight: Item | undefined;
	let wake = Deferred.makeUnsafe<void>();
	let isDone = false;
	let failure: Error | undefined;
	const kick = () => { Deferred.doneUnsafe(wake, Effect.void); };
	function fail(error: Error): void {
		if (failure) return;
		failure = error;
		for (const item of queue.splice(0)) Deferred.doneUnsafe(item.ack, Effect.fail(error));
		if (inflight) Deferred.doneUnsafe(inflight.ack, Effect.fail(error));
		kick();
	}
	async function* stream(): AsyncGenerator<SDKUserMessage> {
		try {
			while (true) {
				while (queue.length === 0 && !isDone && !failure) {
					await Effect.runPromise(Deferred.await(wake));
					wake = Deferred.makeUnsafe<void>();
				}
				if (failure) throw failure;
				const item = queue.shift();
				if (!item) return;
				inflight = item;
				try {
					// The SDK awaits its stdin write before requesting another item.
					yield item.message;
					Deferred.doneUnsafe(item.ack, Effect.void);
				} finally {
					Deferred.doneUnsafe(item.ack, Effect.fail(new Error("prompt stream closed")));
					inflight = undefined;
				}
			}
		} finally {
			isDone = true;
		}
	}
	function enqueue(message: SDKUserMessage): Effect.Effect<void, Error> {
		if (failure || isDone) return Effect.fail(failure ?? new Error("prompt stream closed"));
		const ack = Deferred.makeUnsafe<void, Error>();
		queue.push({ message, ack });
		kick();
		// Promise-based stdin acknowledgments resumed their consumers in a
		// microtask on both success and failure. Preserve that boundary so abort
		// can settle MCP handlers before a rejected steer resumes delivery.
		return Deferred.await(ack).pipe(Effect.matchEffect({
			onSuccess: () => Effect.promise(() => Promise.resolve()),
			onFailure: (error) => Effect.promise(() => Promise.resolve()).pipe(Effect.andThen(Effect.fail(error))),
		}));
	}
	return {
		stream: stream(),
		enqueue,
		// Promise conversion belongs to this SDK AsyncIterable adapter only.
		push: (message) => Effect.runPromise(enqueue(message)),
		end: () => { isDone = true; kick(); },
		fail,
	};
}

/** `uuid` is deliberately omitted: we need no dedup, and supplying one makes
 *  CC's stdin loop do a session lookup on the message. */
export function userMessage(content: SDKUserMessage["message"]["content"], priority?: SDKUserMessage["priority"]): SDKUserMessage {
	return {
		type: "user",
		message: { role: "user", content } as SDKUserMessage["message"],
		parent_tool_use_id: null,
		...(priority ? { priority } : {}),
	};
}
