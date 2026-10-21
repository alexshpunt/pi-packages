import type { PromptStream } from "../prompt-stream.js";
import { QueryContext } from "./query-context.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { deleteSession } from "cc-session-io";
import type { SyncResult } from "../session/sync.js";
import type { BridgeRuntime } from "../runtime.js";

export interface ProviderQueryCompletionInput {
	queryOptions: NonNullable<Parameters<typeof query>[0]["options"]>;
	promptStream: PromptStream;
	queryCtx: QueryContext;
	customToolNameToPi: Map<string, string>;
	model: Model<any>;
	options: SimpleStreamOptions | undefined;
	isReentrant: boolean;
	syncResult: SyncResult;
	cwd: string;
	cliModel: string;
	context: Context;
}

export interface QueryCompletionServices {
	readonly abandonedQueries: WeakSet<object>;
	readonly discardRewrittenQuery: (c: QueryContext) => void;
	readonly startProviderQuery: (input: ProviderQueryCompletionInput) => void;
}

export function createQueryCompletion(runtime: Pick<BridgeRuntime, "activeQueryContexts" | "consumeQuery" | "debug" | "detectPlanFromQuery" | "drainForAbort" | "finalizeCurrentStream" | "historyRewrittenBySession" | "invokeQuery" | "markStreamComplete" | "sessionStateFor" | "setSessionStateFor" | "withdrawHooksIfIdle">): QueryCompletionServices {
	/** Queries pi's history moved out from under. Their completion must not touch
	 *  `sharedSession` or the pi stream: the query that took over the turn has
	 *  already rebuilt both from the new history, and this one's session id names the
	 *  conversation pi just discarded. */
	const abandonedQueries = new WeakSet<object>();

	/** Drop a Claude Code query parked at a tool boundary whose conversation pi has
	 *  since rewritten (/compact, tree navigation).
	 *
	 *  Delivering the turn's tool result into that query hands Claude Code the
	 *  context pi just shrank: one pi turn is one CC query, and the query keeps its
	 *  own context inside the CLI whatever pi does to its transcript. It answers off
	 *  the pre-compaction conversation, reports the pre-compaction usage back, and pi
	 *  crosses the same threshold at the next boundary — measured as one compaction
	 *  per tool call with usage never dropping (issue #101). `needsRebuild` does not
	 *  prevent it: only syncSharedSession reads that flag, and tool-result delivery
	 *  is the one call that never syncs.
	 *
	 *  The caller then takes the fresh-query path, where REBUILD imports pi's
	 *  rewritten history — this tool result included, since it is already in that
	 *  history — so the turn continues instead of ending here. Nothing is lost by
	 *  killing the subprocess: pi owns the only copy of the conversation that counts. */
	function discardRewrittenQuery(c: QueryContext): void {
		const discarded = c.activeQuery as { interrupt?: () => Promise<unknown>; close?: () => void } | null;
		if (discarded) abandonedQueries.add(discarded);
		c.activeQuery = null;
		// Leaving the routing set is what stops this result coming straight back here:
		// contextForToolResults only matches ids against contexts still in it.
		runtime.activeQueryContexts.delete(c);
		c.turnToolCallIds = [];
		c.promptStream?.fail(new Error("conversation rewritten"));
		c.promptStream = null;
		// Settle the parked handlers before killing the CLI, for drainForAbort's
		// reason: one left awaiting a dead subprocess never settles.
		c.releasePendingToolCalls("Context was compacted; this query was discarded.");
		void discarded?.interrupt?.().catch(() => {});
		try { discarded?.close?.(); } catch {}
		// The CLI we just killed may still flush a record into the session JSONL, and
		// the rebuild is the next thing that happens — so rotate rather than race it,
		// exactly as after an abort. Only this session's mirror: the discarding query
		// proves its own conversation is the one being rebuilt around.
		const state = runtime.sessionStateFor(c.piSessionId);
		if (state) runtime.setSessionStateFor(c.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
		if (c.piSessionId) runtime.historyRewrittenBySession.delete(c.piSessionId);
		runtime.debug("provider: history rewritten under a parked query — discarded it, rebuilding from current history");
	}

	function startProviderQuery(input: ProviderQueryCompletionInput): void {
		const { queryOptions, promptStream, queryCtx, customToolNameToPi, model, options, isReentrant, syncResult, cwd, cliModel, context } = input;
		// 3. Start SDK query and claim it for this context
		let wasAborted = false;
		const sdkQuery = runtime.invokeQuery({ prompt: promptStream.stream, options: queryOptions });
		queryCtx.activeQuery = sdkQuery;
		runtime.activeQueryContexts.add(queryCtx);
		runtime.detectPlanFromQuery(sdkQuery);

		// 4. Capture context for abort handling
		const abortCtx = queryCtx;

		const requestAbort = () => {
			// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
			// Both are needed — interrupt alone lets the current API call finish.
			void sdkQuery.interrupt().catch(() => {});
			try { sdkQuery.close(); } catch {}
		};
		const onAbort = () => {
			if (wasAborted) return;
			wasAborted = true;
			runtime.drainForAbort(abortCtx, promptStream);
			requestAbort();
		};
		// The current run owns cancellation, including when it inherits a parked query.
		// Unbind the previous run so its later cleanup cannot abort the new owner.
		let runSignal: AbortSignal | undefined;
		const unbindRunSignal = () => {
			runSignal?.removeEventListener("abort", onAbort);
			runSignal = undefined;
		};
		const bindRunSignal = (signal: AbortSignal | undefined) => {
			unbindRunSignal();
			runSignal = signal;
			if (!signal) return;
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		};
		queryCtx.bindRunSignal = bindRunSignal;
		bindRunSignal(options?.signal);

		// Background consumer — runs until query ends
		runtime.consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
			.then(async ({ capturedSessionId }) => {
				runtime.debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`);

				// Discarded out from under: the query continuing the turn owns the context,
				// the session and the stream. Capturing this one's session id here would put
				// Claude Code back on the conversation it was discarded for.
				if (abandonedQueries.has(sdkQuery)) {
					runtime.debug("provider: discarded query completed, leaving session and stream to its replacement");
					return;
				}

				// --- Abort detection in normal completion path ---
				if (wasAborted || runSignal?.aborted) {
					// The killed subprocess may flush a late record into this session's
					// JSONL — its own mirror's next sync must rebuild and rotate.
					const state = runtime.sessionStateFor(queryCtx.piSessionId);
					if (state) runtime.setSessionStateFor(queryCtx.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
					runtime.debug(`provider: abort detected, marked sharedSession needsRebuild + forceRotate`);
					if (queryCtx.turnOutput) {
						queryCtx.turnOutput.stopReason = "aborted";
						queryCtx.turnOutput.errorMessage = "Operation aborted";
					}
					const stream = queryCtx.currentPiStream;
					stream?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
					runtime.markStreamComplete(stream);
					stream?.end();
					queryCtx.currentPiStream = null;
					queryCtx.heldRateLimit = undefined;
					return;
				}

				// --- Capture session ID ---
				// This query's own mirror — a reentrant subagent completing does not
				// reassign the parent's conversation to the child's CC file.
				if (syncResult.preserveSharedSession) {
					const state = runtime.sessionStateFor(queryCtx.piSessionId);
					if (capturedSessionId && capturedSessionId !== state?.sessionId) {
						deleteSession(capturedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
						runtime.debug(`provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`);
					}
					runtime.debug(`provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`);
				} else {
					const state = runtime.sessionStateFor(queryCtx.piSessionId);
					const sessionId = capturedSessionId ?? state?.sessionId;
					// An error result (429, overload, 5xx) is a turn pi may retry: it drops the
					// failed assistant message and resends the same context, ending at the same
					// user turn. Advancing the cursor past that turn makes the retry look like a
					// shorter context, so it took the clean-start-and-preserve branch — a
					// history-less session, deleted afterwards — and the next turn resumed this
					// session without the retried answer. Hold the cursor and arm a rebuild
					// instead: the retry rewrites this session from pi's history and resumes it.
					// Rebuild rather than resume, because CC already wrote the failed prompt into
					// the session file and resuming would send it twice.
					const hasFailed = queryCtx.turnOutput?.stopReason === "error";
					if (sessionId) {
						const cursor = hasFailed
							? state?.cursor ?? 0
							: Math.max(context.messages.length, queryCtx.latestCursor, state?.cursor ?? 0);
						runtime.debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}${hasFailed ? " (error result: cursor held, rebuild armed)" : ""}`);
						// A missed steer may precede the first mirror or arrive while this
						// query is still able to complete. Preserve both rebuild signals.
						runtime.setSessionStateFor(queryCtx.piSessionId, { ...state, sessionId, cursor, cwd, piSessionId: queryCtx.piSessionId ?? undefined, needsRebuild: hasFailed || queryCtx.missedSteer || state?.needsRebuild });
					}
				}

				if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
					runtime.debug("provider: clearing activeQuery before final stream completion");
					queryCtx.activeQuery = null;
				}
				runtime.finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
			})
			.catch((error) => {
				const isAborted = wasAborted || runSignal?.aborted === true;
				runtime.debug(`provider: query error, model=${cliModel}, aborted=${isAborted}, error=`, error);
				if (abandonedQueries.has(sdkQuery)) {
					runtime.debug("provider: discarded query ended in error, leaving session and stream to its replacement");
					return;
				}
				if (isAborted) {
					const state = runtime.sessionStateFor(queryCtx.piSessionId);
					if (state) runtime.setSessionStateFor(queryCtx.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
					queryCtx.heldRateLimit = undefined;
				} else {
					// Keep the known CC id as the rebuild source, without advancing the
					// failed turn's cursor. Abort/discard paths still own forceRotate;
					// an exception in one session must not erase a sibling's mirror.
					const state = runtime.sessionStateFor(queryCtx.piSessionId);
					if (state) runtime.setSessionStateFor(queryCtx.piSessionId, { ...state, needsRebuild: true });
				}
				promptStream.fail(error instanceof Error ? error : new Error(String(error)));
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = isAborted ? "aborted" : "error";
					// The SDK drops its copy of the result text if any message follows the error
					// result, so prefer the cause consumeQuery recorded off the result itself.
					queryCtx.turnOutput.errorMessage ??= error instanceof Error ? error.message : String(error);
				}
				if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
					queryCtx.releasePendingToolCalls("Query ended");
					runtime.debug("provider: clearing activeQuery before error stream completion");
					queryCtx.activeQuery = null;
				}
				const stream = queryCtx.currentPiStream;
				stream?.push({ type: "error", reason: (queryCtx.turnOutput?.stopReason ?? "error") as "aborted" | "error", error: queryCtx.turnOutput! });
				runtime.markStreamComplete(stream);
				stream?.end();
				queryCtx.currentPiStream = null;
			})
			.finally(() => {
				unbindRunSignal();
				if (queryCtx.bindRunSignal === bindRunSignal) queryCtx.bindRunSignal = null;
				// Settle any ack still parked in the generator — the CLI is gone, so
				// nothing will resume it. Clear the handle only if a later query
				// hasn't already claimed the shared context.
				promptStream.fail(new Error("query ended"));
				if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
				// A later query claiming this context sets activeQuery to its own handle;
				// null means the .then/.catch above cleared ours and nothing replaced it.
				// Testing only for `=== sdkQuery` would never fire on the non-reentrant
				// path, leaving the top-level context in the routing set forever — where a
				// later orphaned tool result matches its stale turnToolCallIds and takes
				// the delivery branch, returning a stream nothing ends.
				if (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null) {
					queryCtx.releasePendingToolCalls("Query ended");
					queryCtx.activeQuery = null;
					runtime.activeQueryContexts.delete(queryCtx);
				}
				runtime.withdrawHooksIfIdle();
				sdkQuery.close();
			});

	}

	return {
		abandonedQueries,
		discardRewrittenQuery,
		startProviderQuery,
	};
}
