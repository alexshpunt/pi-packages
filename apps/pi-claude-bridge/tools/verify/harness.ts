import { setTimeout as delay } from "node:timers/promises";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "../../src/features/session/convert.js";
import { applyLongContext, resolveClaudeCodeRuntimeModel } from "../../src/features/models/policy.js";
import { createBridgeHarness } from "./bridge-runtime.js";
import { EnvironmentError, expect } from "./types.js";
import { assertAllowedModel, MODEL_ID } from "./policy.js";
import type { VerificationWorkspace } from "./workspace.js";

export function createHarness(workspace: VerificationWorkspace, requestedModel = MODEL_ID) {
	// A fresh runtime owns fresh per-session query state; nothing to reset first.
	const runtime = createBridgeHarness();
	// A check must install either an offline double or the guarded live runner.
	runtime.setQuery(() => { throw new EnvironmentError("live-query-not-authorized"); });
	const requested = requestedModel.replace(/^claude-bridge\//, "");
	assertAllowedModel(requestedModel);
	const registered = applyLongContext(runtime.MODELS, runtime.longContextSettings).find(model => model.id === MODEL_ID);
	if (!registered) throw new EnvironmentError("haiku-model-unavailable");
	const model = { ...registered, provider: PROVIDER_ID, api: PROVIDER_ID, baseUrl: PROVIDER_ID } as Model<any>;
	const cliModel = resolveClaudeCodeRuntimeModel(model, runtime.longContextSettings).cliModelId;
	if (requested.endsWith("[1m]") && requested !== cliModel) throw new EnvironmentError("native-model-not-registered");

	async function waitForIdle(timeoutMs = 10000) {
		const deadlineMs = Date.now() + timeoutMs;
		while (runtime.activeQueryContexts.size && Date.now() < deadlineMs) await delay(10);
		expect(runtime.activeQueryContexts.size === 0, "query-did-not-settle");
	}

	async function turn(context: Context, options: SimpleStreamOptions = {}) {
		return runtime.streamClaudeAgentSdk(model, context, { ...options, sessionId: options.sessionId ?? workspace.sessionId }).result();
	}

	async function close() {
		for (const context of runtime.activeQueryContexts) {
			context.releasePendingToolCalls("Verification ended.");
			(context.activeQuery as { close?: () => void } | null)?.close?.();
			context.promptStream?.end();
		}
		try { await waitForIdle(); }
		finally {
			runtime.setQuery(() => { throw new EnvironmentError("verification-runtime-closed"); });
			runtime.clearSessions();
			// Test-only reset of this harness's own runtime, not the production
			// per-session release a session_shutdown performs.
			runtime.sessionQueryContexts.clear();
		}
	}
	return { runtime, model, cliModel, turn, waitForIdle, close };
}

export const fixtureUser = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
