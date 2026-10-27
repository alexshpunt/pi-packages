import { Context as ServiceContext, Deferred, Effect, Layer } from "effect";
import type { PromptStream } from "../../adapters/claude/types.js";
import type { McpResult, ToolBridgeDependencies, ToolBridgeServices } from "./types.js";
import { Diagnostics } from "../../diagnostics/service.js";
import { SessionStore } from "../session/mirror-store.js";
import { Configuration } from "../../configuration/service.js";
import { extractAllToolResults as _extractAllToolResults } from "./results.js";
import { createToolServer } from "../../adapters/claude/mcp-server.js";
import { userMessage } from "../../adapters/claude/prompt-input.js";
import { QueryContext } from "../query/state.js";
import { MCP_SERVER_NAME } from "../prompt/skills.js";
import { MCP_TOOL_PREFIX } from "../prompt/skills.js";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { Context } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";

export function createToolBridge({ diagnostics, sessions, configuration }: ToolBridgeDependencies): ToolBridgeServices {
	// Pi doesn't pass tool results directly — it appends them to the context and calls
	// the provider again. Thin wrapper over results.ts that adds per-turn
	// debug logging at the extraction boundary.
	function extractAllToolResults(context: Context): McpResult[] {
		const { results, stopIdx } = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
		diagnostics.debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
		diagnostics.debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
		if (diagnostics.DEBUG) {
			for (let r = 0; r < results.length; r++) {
				diagnostics.debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
			}
		}
		return results;
	}

	// --- Provider helpers: tool name mapping ---


	// Provider path: the query runs with `tools: []`, so the only tools CC can
	// legitimately call are the pi tools we serve over MCP. Any other name is the
	// model hallucinating a builtin (`bash`, `Bash`, `Edit`, an MCP server we don't
	// serve). CC answers those itself with "No such tool available" and retries
	// inside the same query, never dispatching them to our MCP server — so a tool
	// call under such a name must not reach pi. Forwarding one ran a tool CC never
	// dispatched (real side effects) and, because the retry carries a fresh
	// tool_use id, left the handler for the retry with no result to release it:
	// pi's result arrived keyed to the dead id, and both sides deadlocked.
	function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
		return customToolNameToPi.get(name) ?? customToolNameToPi.get(name.toLowerCase());
	}

	// Renames for Claude Code SDK param names that differ from pi's native names.
	// Keys not listed here pass through unchanged, so new pi params work automatically.
	const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
		read:  { file_path: "path" },
		write: { file_path: "path" },
		edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
	};

	// Maps SDK tool args to pi tool args via key renaming + pass-through.
	// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
	function mapToolArgs(
		toolName: string, args: Record<string, unknown> | undefined,
	): Record<string, unknown> {
		const input = args ?? {};
		const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(input)) {
			const piKey = renames?.[key] ?? key;
			if (!(piKey in result)) result[piKey] = value; // first alias wins
		}
		// No default bash timeout: an argument the model did not send would reach
		// pi's history but not Claude Code's, and every rebuild would then miss the
		// prompt cache from the first such call. A default belongs in pi's bash tool
		// itself (e.g. an extension that applies one at execution time).
		return result;
	}

	function resolveMcpTools(context: Context): {
		mcpTools: Tool[];
		customToolNameToSdk: Map<string, string>;
		customToolNameToPi: Map<string, string>;
	} {
		const mcpTools: Tool[] = [];
		const customToolNameToSdk = new Map<string, string>();
		const customToolNameToPi = new Map<string, string>();

		if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

		for (const tool of context.tools) {
			const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
			mcpTools.push(tool);
			customToolNameToSdk.set(tool.name, sdkName);
			customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
			customToolNameToPi.set(sdkName, tool.name);
			customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
		}

		return { mcpTools, customToolNameToSdk, customToolNameToPi };
	}

	// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
	// blocks on a Promise until pi delivers the tool result via streamSimple.
	// Handlers receive their toolCallId from Claude's tools/call _meta, so results
	// are matched by ID end to end.
	//
	// The handler and pi's result can arrive in either order, hence the two maps:
	// a result that lands first waits in `pendingResults` for the handler to claim
	// it, and a handler that runs first parks its resolver in `pendingToolCalls`.
	// Handlers close over the captured `queryCtx`, ensuring they operate on the
	// correct query's state while multiple queries run concurrently.
	//
	// Each tool also carries the `_meta` pi's extensions report for it (an MCP
	// server's own `_meta`, see adapters/pi/tool-meta.ts), unchanged. Tools nobody
	// reports one for get none.
	function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createToolServer>> | undefined {
		if (!tools.length) return undefined;
		let metas: ReadonlyMap<string, Record<string, unknown>> = new Map();
		try {
			metas = configuration.listPiToolMeta?.() ?? metas;
		} catch (error) {
			diagnostics.debug("WARNING: could not list pi's tools for their _meta:", error);
		}
		const mcpTools = tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.parameters,
			meta: metas.get(tool.name),
			handler: (toolCallId: string) => {
				if (queryCtx.pendingResults.has(toolCallId)) {
					const result = queryCtx.pendingResults.get(toolCallId)!;
					queryCtx.pendingResults.delete(toolCallId);
					diagnostics.debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
					return Effect.succeed(result);
				}
				diagnostics.debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
				const pending = Deferred.makeUnsafe<McpResult>();
				queryCtx.pendingToolCalls.set(toolCallId, {
					toolName: tool.name,
					resolve: (result) => { Deferred.doneUnsafe(pending, Effect.succeed(result)); },
				});
				return Deferred.await(pending);
			},
		}));
		return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
	}

	/** A steer that never made it into CC's session. The cursor has already counted
	 *  it, so count-based sync would skip it forever — rebuild instead, which
	 *  re-imports the message from pi's context. */
	function steerMissedSession(c: QueryContext, text: string): void {
		c.missedSteer = true;
		const state = sessions.sessionStateFor(c.piSessionId);
		if (state) sessions.setSessionStateFor(c.piSessionId, { ...state, needsRebuild: true });
		diagnostics.debug(`provider: steer never reached CC, marked query for rebuild: ${text.slice(0, 60)}`);
	}

	/** Releases this turn's tool results to their MCP handlers, after first pushing
	 *  any steer to CC.
	 *
	 *  The ordering is mandatory, not an optimization. The steer and the MCP tool
	 *  result travel back to CC over the same stdin FIFO. Awaiting the push ack
	 *  (which resolves only once the SDK's write to stdin completed) before
	 *  resolving any handler guarantees CC enqueues the steer *before* it reads the
	 *  tool result, so its post-tool-call drain sees it and acts on it this turn.
	 *  Resolve first and the steer misses the drain, silently degrading to
	 *  follow-up semantics.
	 *
	 *  Both the post-tool-call drain and the FIFO ordering are CC CLI internals,
	 *  not SDK contract — tests/int-tool-message.mjs is the tripwire if they move. */
	function deliverToolResults(
		c: QueryContext,
		results: McpResult[],
		steer: ContentBlockParam[] | null,
		contextLength: number,
	): Effect.Effect<void> {
		return Effect.gen(function* () {
		if (steer) {
			const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
			if (!c.promptStream) {
				diagnostics.debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
				steerMissedSession(c, text);
			} else {
				yield* c.promptStream.enqueue(userMessage(steer, "next")).pipe(
					Effect.tap(() => Effect.sync(() => diagnostics.debug(`provider: steer written to CC stdin before tool result: ${text.slice(0, 60)}`))),
					Effect.catch((error) => Effect.sync(() => {
						diagnostics.debug("provider: steer push rejected, delivering tool result anyway:", error);
						steerMissedSession(c, text);
					})),
				);
			}
		}

		diagnostics.debug(`provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers, ctx.msgs=${contextLength}`);
		for (const result of results) {
			const id = result.toolCallId;
			if (id && c.pendingToolCalls.has(id)) {
				const pending = c.pendingToolCalls.get(id)!;
				c.pendingToolCalls.delete(id);
				if (diagnostics.DEBUG) diagnostics.debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
				pending.resolve(result);
			} else if (id) {
				c.pendingResults.set(id, result);
				diagnostics.debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
			} else {
				diagnostics.debug(`WARNING: tool result without toolCallId, cannot match`);
			}
			// Parallel results can leave different IDs waiting in opposite maps.
			// Only the same ID in both maps violates the pairing invariant.
			if (c.pendingResults.size > 0 && [...c.pendingToolCalls.keys()].some(id => c.pendingResults.has(id))) {
				diagnostics.debug(`BUG: both maps non-empty! handlers=${c.pendingToolCalls.size} results=${c.pendingResults.size}`);
			}
		}
		if (c.pendingToolCalls.size > 0) {
			diagnostics.debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`);
			configuration.piUI?.notify(`Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
		}
		});
	}

	/** Abort teardown for one query: settle everything that would otherwise be left
	 *  awaiting a subprocess we are about to kill. The pump abandons iteration on
	 *  abort, so an in-flight prompt-stream push would hang forever and take
	 *  tool-result delivery with it. */
	function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
		promptStream.fail(new Error("Operation aborted"));
		c.releasePendingToolCalls("Operation aborted");
	}

	return {
		buildMcpServers,
		deliverToolResults,
		drainForAbort,
		extractAllToolResults,
		mapToolArgs,
		piToolNameFor,
		resolveMcpTools,
	};
}

export class ToolBridge extends ServiceContext.Service<ToolBridge, ToolBridgeServices>()("claude-bridge/ToolBridge") {}
export const ToolBridgeLive = Layer.effect(ToolBridge, Effect.gen(function* () {
	const diagnostics = yield* Diagnostics;
	const sessions = yield* SessionStore;
	const configuration = yield* Configuration;
	return createToolBridge({ diagnostics, sessions, configuration });
}));
