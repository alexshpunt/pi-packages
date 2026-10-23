import { Effect, type Scope } from "effect";
import type { QueryMessages } from "./types.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { fromPromise } from "../effects.js";

/** Preserve AsyncIteratorClose on early exit, including fiber interruption. */
export function acquireQueryMessages(source: AsyncIterable<SDKMessage>): Effect.Effect<QueryMessages, never, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.sync(() => {
			const iterator = source[Symbol.asyncIterator]();
			let hasFinished = false;
			let hasFailed = false;
			return {
				next: fromPromise(() => iterator.next()).pipe(
					Effect.tap((next) => Effect.sync(() => { hasFinished = next.done === true; })),
					Effect.tapError(() => Effect.sync(() => { hasFailed = true; })),
				),
				close: Effect.suspend(() => {
					if (hasFinished || hasFailed || !iterator.return) return Effect.void;
					return fromPromise(() => iterator.return!()).pipe(Effect.catchCause(() => Effect.void), Effect.asVoid);
				}),
			};
		}),
		(messages) => messages.close,
	);
}
