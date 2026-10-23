import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import bridge, { testBridge } from "../fixture-entry.js";
import { withLiveRunner } from "../live.js";
import { MODEL_ID } from "../policy.js";
import { expect, VerificationError, type Facts } from "../types.js";
import type { VerificationWorkspace } from "../workspace.js";

interface ProcessState {
	apiCalls: number;
	factoryCount: number;
	providerEntryCount: number;
	hasSentReady: boolean;
	isFinishing: boolean;
	phases: Facts[];
	snapshots: Facts[];
	events: Facts[];
	payloadChecks: Facts[];
	expectation?: { label: string; required?: string; forbidden?: string };
}
const key = Symbol.for("claude-bridge:owned-lifecycle-verification");
const send = (message: Facts) => new Promise<void>((resolve, reject) => {
	if (!process.send) { reject(new Error("owned-process-required")); return; }
	process.send(message, error => error ? reject(error) : resolve());
});

/** Reload-persistent observations belong only to this owned verification process. */
export default async function (pi: ExtensionAPI) {
	expect(process.send && process.env.BRIDGE_VERIFY_WORKSPACE, "owned-verification-process-required");
	const globals = globalThis as Record<symbol, unknown>;
	const state = (globals[key] ??= { apiCalls: 0, factoryCount: 0, providerEntryCount: 0, hasSentReady: false, isFinishing: false,
		phases: [], snapshots: [], events: [], payloadChecks: [] }) as ProcessState;
	const generation = ++state.factoryCount;
	const debug = testBridge.debug;
	testBridge.debug = (...values: unknown[]) => {
		if (String(values[0]).startsWith("provider: streamClaudeAgentSdk called,")) state.providerEntryCount++;
		debug(...values);
	};
	const workspace = JSON.parse(process.env.BRIDGE_VERIFY_WORKSPACE!) as VerificationWorkspace;
	const context = {
		appDir: fileURLToPath(new URL("../../../", import.meta.url)), modelId: MODEL_ID, isLive: true,
		get apiCalls() { return state.apiCalls; },
		set apiCalls(value: number) { void send({ kind: "bridge-verification-api-call", count: value - state.apiCalls }); state.apiCalls = value; },
	};
	let currentContext: ExtensionContext | undefined;
	let engine: Promise<Facts> | undefined;
	let finish: (() => void) | undefined;
	const snapshot = (label: string, ctx = currentContext) => {
		if (!ctx) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const mirror = testBridge.getSharedSession(sessionId);
		const hooks = (name: string) => globals[Symbol.for(name)] as Set<unknown> | undefined;
		state.snapshots.push({ label, generation, sessionId, mirrorId: mirror?.sessionId ?? null,
			hasRebuildMarker: mirror?.needsRebuild === true, activeQueries: testBridge.activeQueryContexts.size,
			hasRebuildHook: hooks("claude-bridge:markRebuildHooks")?.has(testBridge.markRebuildForSession) ?? false,
			hasReleaseHook: hooks("claude-bridge:releaseSessionQueriesHooks")?.has(testBridge.releaseSessionQueryContext) ?? false });
	};
	async function startEngine() {
		if (engine) return;
		let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
		const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
		const finished = new Promise<void>(resolve => { finish = resolve; });
		engine = withLiveRunner(context, async runner => {
			const queries: Facts[] = [];
			testBridge.setQuery(input => {
				queries.push({ resume: input.options?.resume ?? null, isSummary: input.options?.persistSession === false });
				return runner.harness.runtime.invokeQuery(input);
			});
			resolveReady();
			await finished;
			const deadlineMs = Date.now() + 10000;
			while (testBridge.activeQueryContexts.size && Date.now() < deadlineMs) await delay(10);
			expect(testBridge.activeQueryContexts.size === 0, "lifecycle-query-did-not-settle");
			return { generation, queries, isQueryStateReleased: true,
				modelContextContainsLinkEntry: runner.requests.some(request => JSON.stringify(runner.payloadFor(request)).includes("claude-bridge-cc-session")) };
		}, 240000, undefined, workspace, payload => {
			const expectation = state.expectation;
			if (expectation) {
				const value = JSON.stringify(payload);
				const hasRequired = !expectation.required || value.includes(expectation.required);
				const hasForbidden = !!expectation.forbidden && value.includes(expectation.forbidden);
				state.payloadChecks.push({ label: expectation.label, hasRequired, hasForbidden });
				state.expectation = undefined;
				expect(hasRequired && !hasForbidden, "lifecycle-model-context-mismatch", { label: expectation.label, hasRequired, hasForbidden });
			}
			return payload;
		}, { shouldStreamResponses: true });
		void engine.catch(rejectReady);
		await ready;
	}
	async function stopEngine() {
		if (!engine) return;
		const current = engine;
		engine = undefined;
		finish?.();
		try { state.phases.push(await current); }
		finally { testBridge.setQuery(() => { throw new VerificationError("lifecycle-guard-not-running"); }); }
	}
	function onMessage(message: unknown) {
		if (!message || typeof message !== "object" || (message as Facts).kind !== "bridge-verification-finish" || state.isFinishing) return;
		state.isFinishing = true;
		// A shutdown request made from IPC can wait for another RPC command.
		// Acknowledge first; the parent then closes stdin to drive real disposal.
		void send({ kind: "bridge-verification-finishing" }).catch(() => {});
	}

	bridge(pi);
	await startEngine();
	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		await startEngine();
		pi.setActiveTools(["bridge_verify_wait"]);
		expect(pi.getActiveTools().length === 1 && pi.getActiveTools()[0] === "bridge_verify_wait", "verification-tool-not-active");
		process.off("message", onMessage); process.on("message", onMessage);
		state.events.push({ type: "session_start", generation, sessionId: ctx.sessionManager.getSessionId() });
		snapshot("start", ctx);
		if (!state.hasSentReady) {
			state.hasSentReady = true;
			await send({ kind: "bridge-verification-ready", piSessionId: ctx.sessionManager.getSessionId() });
		}
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		process.off("message", onMessage);
		state.events.push({ type: "session_shutdown", generation, sessionId: ctx.sessionManager.getSessionId() });
		try {
			await stopEngine();
			snapshot("shutdown", ctx);
			if (state.isFinishing) await send({ kind: "bridge-verification-result", apiCalls: state.apiCalls,
				observed: { factoryCount: state.factoryCount, phases: state.phases, snapshots: state.snapshots, lifecycleEvents: state.events, payloadChecks: state.payloadChecks } });
		} catch (error) {
			await send({ kind: "bridge-verification-error", apiCalls: state.apiCalls, code: error instanceof VerificationError ? error.code : "lifecycle-shutdown-failed" });
		} finally { testBridge.debug = debug; }
	});
	pi.on("message_end", event => {
		if (event.message.role === "assistant" && event.message.stopReason === "error" && event.message.errorMessage === "This operation was aborted")
			state.events.push({ type: "host-setup-abort-error", providerEntryCount: state.providerEntryCount });
	});
	pi.on("session_before_compact", event => { state.events.push({ type: "session_before_compact", generation, keepRecentTokens: event.preparation.settings.keepRecentTokens }); });
	pi.on("session_compact", (_event, ctx) => { state.events.push({ type: "session_compact", generation }); snapshot("compact", ctx); });
	pi.on("session_tree", (_event, ctx) => { state.events.push({ type: "session_tree", generation }); snapshot("tree", ctx); });
	pi.registerCommand("bridge-verify", {
		description: "Owned verification controls for lifecycle assertions",
		handler: async (args, ctx) => {
			const [action, label, required, forbidden] = args.split(" ");
			await ctx.waitForIdle();
			if (action === "snapshot") { snapshot(label, ctx); return; }
			if (action === "expect") { state.expectation = { label, required: required === "-" ? undefined : required, forbidden: forbidden === "-" ? undefined : forbidden }; return; }
			if (action === "tree") { const result = await ctx.navigateTree(label, { summarize: false }); expect(!result.cancelled, "tree-navigation-canceled"); return; }
			if (action === "reload") { await ctx.reload(); return; }
			throw new VerificationError("unknown-lifecycle-command");
		},
	});
	pi.registerTool({
		name: "bridge_verify_wait", label: "Verification wait", description: "Wait until the verification caller cancels. Call only when explicitly requested.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			return new Promise<never>((_resolve, reject) => {
				const abort = () => {
					state.events.push({ type: "tool-abort", isAborted: signal?.aborted === true, providerEntryCount: state.providerEntryCount });
					clearTimeout(timeout); signal?.removeEventListener("abort", abort); reject(new Error("Verification tool canceled"));
				};
				const timeout = setTimeout(() => { signal?.removeEventListener("abort", abort); reject(new Error("Verification tool timed out")); }, 30000);
				if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
			});
		},
	});
}
