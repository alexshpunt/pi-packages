import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Query, query } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { forgetSessionCwd, rememberSessionCwd } from "../../src/adapters/pi/session-cwd.js";
import { createHarness, fixtureUser } from "./harness.js";
import { expect, type CheckContext, type Facts } from "./types.js";
import { withWorkspace, type VerificationWorkspace } from "./workspace.js";

// Two pi sessions served by one production runtime, driven offline: a scripted
// query() replays SDK messages and parks on gates, so session A can sit at a tool
// boundary while session B runs. No Claude Code process starts.

type ScriptStep = Facts | (() => Promise<void>);
interface ScriptedQuery { label: string; steps: ScriptStep[]; }
interface ScriptedCall { label: string; resume: string | null; }
type Harness = ReturnType<typeof createHarness>;

export function gate() {
	let open!: () => void;
	const opened = new Promise<void>(resolve => { open = resolve; });
	return { wait: () => opened, open };
}

export const init = (sessionId: string): Facts => ({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: "none" });
export const success = (text: string): Facts => ({ type: "result", subtype: "success", is_error: false, result: text });
const streamEvent = (event: Facts): Facts => ({ type: "stream_event", event });
export const toolUse = (id: string): Facts[] => [
	streamEvent({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
	streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a\"}" } }),
	streamEvent({ type: "content_block_stop", index: 0 }),
	streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	streamEvent({ type: "message_stop" }),
];

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export const assistantText = (text: string): AssistantMessage => ({
	role: "assistant", content: [{ type: "text", text }], api: "claude-bridge", provider: "claude-bridge",
	model: "claude-haiku-5-5", usage: emptyUsage(), stopReason: "stop", timestamp: 0,
});
export const toolResult = (id: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "fixture file" }], isError: false, timestamp: 0 });
// The bridge only turns a tool_use into a pi tool call for a tool the context serves.
const tools = [{ name: "read", description: "Read a verification fixture.", parameters: Type.Object({ path: Type.String() }) }];

function installScriptedQueries(harness: Harness) {
	const scripts: ScriptedQuery[] = [];
	const calls: ScriptedCall[] = [];
	harness.runtime.setQuery((input: Parameters<typeof query>[0]) => {
		const script = scripts.shift();
		expect(script, "scripted-query-missing");
		const resume = input.options?.resume ?? null;
		calls.push({ label: script.label, resume });
		let isClosed = false;
		let markClosed!: () => void;
		const closed = new Promise<void>(resolve => { markClosed = resolve; });
		const iterator = (async function* () {
			// Claude Code reads the first prompt from stdin before it initializes.
			if (typeof input.prompt !== "string") await input.prompt[Symbol.asyncIterator]().next();
			for (const step of script.steps) {
				if (typeof step === "function") { await Promise.race([step(), closed]); if (isClosed) return; continue; }
				if (isClosed) return;
				yield resume && step.type === "system" ? { ...step, session_id: resume } : step;
			}
		})();
		return Object.assign(iterator, { interrupt: async () => {}, close() { isClosed = true; markClosed(); } }) as unknown as Query;
	});
	return { scripts, calls };
}

/** The bridge logs each fresh query's sync decision as `syncResult: path=...`;
 *  keep only the path token, in memory. */
function observeSyncPaths(harness: Harness): string[] {
	const paths: string[] = [];
	const debug = harness.runtime.debug;
	harness.runtime.debug = (...args: unknown[]) => {
		const match = typeof args[0] === "string" ? /^syncResult: path=(clean-start preserve-shared|clean-start|reuse|rebuild)\b/.exec(args[0]) : null;
		if (match) paths.push(match[1]);
		debug(...args);
	};
	return paths;
}

export interface TwoSessions {
	harness: Harness;
	workspace: VerificationWorkspace;
	scripts: ScriptedQuery[];
	calls: ScriptedCall[];
	syncPaths: string[];
	sessionA: string;
	sessionB: string;
	turn(sessionId: string, messages: Message[], signal?: AbortSignal): Promise<AssistantMessage>;
	/** Wait until only `remaining` of the session's queries are still in flight. */
	waitForSession(sessionId: string, remaining?: number): Promise<void>;
	activeContextFor(sessionId: string): unknown;
	activeCountFor(sessionId: string): number;
}

export async function withTwoSessions(context: CheckContext, run: (sessions: TwoSessions) => Promise<Facts>): Promise<Facts> {
	return withWorkspace(false, async workspace => {
		const harness = createHarness(workspace, context.modelId);
		const { scripts, calls } = installScriptedQueries(harness);
		const syncPaths = observeSyncPaths(harness);
		const sessionA = randomUUID();
		rememberSessionCwd(sessionA, workspace.cwd);
		const activeFor = (sessionId: string) => [...harness.runtime.activeQueryContexts].filter(c => c.piSessionId === sessionId);
		const sessions: TwoSessions = {
			harness, workspace, scripts, calls, syncPaths, sessionA, sessionB: workspace.sessionId,
			turn: (sessionId, messages, signal) => harness.turn({ messages, tools }, { sessionId, signal }),
			async waitForSession(sessionId, remaining = 0) {
				const deadlineMs = Date.now() + 10000;
				while (activeFor(sessionId).length > remaining && Date.now() < deadlineMs) await delay(10);
				expect(activeFor(sessionId).length === remaining, "session-query-did-not-settle");
			},
			activeContextFor: sessionId => activeFor(sessionId)[0],
			activeCountFor: sessionId => activeFor(sessionId).length,
		};
		try { return await run(sessions); }
		finally {
			try { await harness.close(); }
			finally { forgetSessionCwd(sessionA); }
		}
	});
}

/** Session A completes one turn, then parks its second turn on a tool call. */
export async function parkSessionA(sessions: TwoSessions) {
	const { scripts, sessionA, turn, waitForSession, harness } = sessions;
	const first = fixtureUser("Session A first fixture.");
	scripts.push({ label: "A turn 1", steps: [init("cc-session-a"), success("Session A first answer.")] });
	const firstAnswer = await turn(sessionA, [first]);
	await waitForSession(sessionA);
	const toolCallId = "toolu_session_a";
	const resume = gate();
	scripts.push({ label: "A turn 2", steps: [init("cc-session-a-next"), ...toolUse(toolCallId), resume.wait, success("Session A second answer.")] });
	const history: Message[] = [first, firstAnswer, fixtureUser("Session A second fixture.")];
	const parked = await turn(sessionA, history);
	expect(parked.stopReason === "toolUse", "session-a-not-parked", { stopReason: parked.stopReason });
	history.push(parked);
	const parkedContext = sessions.activeContextFor(sessionA) as { activeQuery: unknown; latestCursor: number; bindRunSignal: unknown } | undefined;
	expect(parkedContext, "session-a-context-missing");
	const snapshot = () => ({
		isSameContext: sessions.activeContextFor(sessionA) === parkedContext,
		activeQuery: parkedContext.activeQuery,
		latestCursor: parkedContext.latestCursor,
		hasRunSignalBinding: parkedContext.bindRunSignal !== null,
		mirrorSessionId: harness.runtime.sessionStateFor(sessionA)?.sessionId ?? null,
		mirrorCursor: harness.runtime.sessionStateFor(sessionA)?.cursor ?? null,
	});
	const before = snapshot();

	/** Whether B's work left A's parked query, cursor and CC id alone, then
	 *  deliver A's own tool result and let the turn finish on its own query. */
	async function finish(): Promise<Facts> {
		const after = snapshot();
		const isUnchanged = after.isSameContext && after.activeQuery === before.activeQuery && after.activeQuery !== null
			&& after.latestCursor === before.latestCursor && after.hasRunSignalBinding
			&& after.mirrorSessionId === before.mirrorSessionId && after.mirrorCursor === before.mirrorCursor;
		const delivery = turn(sessionA, [...history, toolResult(toolCallId)]);
		resume.open();
		const answer = await delivery;
		await waitForSession(sessionA);
		const mirror = harness.runtime.sessionStateFor(sessionA);
		return {
			isParkedQueryUnchanged: isUnchanged,
			cursorWhileParked: before.mirrorCursor,
			completedStopReason: answer.stopReason,
			finalSessionId: mirror?.sessionId === "cc-session-a" ? "own" : mirror ? "other" : null,
			finalCursor: mirror?.cursor ?? null,
		};
	}
	return { finish };
}
