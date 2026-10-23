import { Effect, Exit, Scope, type Fiber } from "effect";
import type { QueryEndReason, QueryPhase } from "./types.js";
import type { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { fromPromise } from "../../adapters/effects.js";

/** One immutable resource owner per SDK invocation, even when its session slot is reused. */
export class QueryExecution {
	readonly scope: Scope.Closeable;
	#phase: QueryPhase = "active";
	#reason: QueryEndReason | undefined;
	get phase(): QueryPhase { return this.#phase; }
	get reason(): QueryEndReason | undefined { return this.#reason; }
	fiber: Fiber.Fiber<void> | undefined;

	constructor(readonly query: ReturnType<typeof sdkQuery>, lifetimeScope: Scope.Scope) {
		this.scope = Scope.forkUnsafe(lifetimeScope, "sequential");
	}

	beginClosing(reason?: QueryEndReason): void {
		if (this.#phase === "closed") return;
		this.#phase = "closing";
		this.#reason ??= reason;
	}

	requestStop(reason: "aborted" | "discarded"): void {
		if (this.#phase === "closed") return;
		this.beginClosing(reason);
		// Native AbortSignal/MCP callbacks are imperative entry points. The stop
		// request is still a fiber owned by this query and cannot outlive its scope.
		Effect.runSync(Effect.forkIn(
			fromPromise(() => this.query.interrupt()).pipe(Effect.catchCause(() => Effect.void)),
			this.scope,
			{ startImmediately: true },
		));
		try { this.query.close(); } catch { /* best-effort stop */ }
		this.fiber?.interruptUnsafe();
	}

	closed(reason: QueryEndReason): void {
		this.#reason ??= reason;
		this.#phase = "closed";
	}

	closeScope() {
		return Scope.close(this.scope, Exit.void);
	}
}
