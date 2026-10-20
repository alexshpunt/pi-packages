import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import bridge, { __test } from "../../../src/index.js";
import { captureRequestPrefix, messageShapes, systemTextAsBlocks } from "../fidelity.js";
import { withLiveRunner, type LiveRunner } from "../live.js";
import { MODEL_ID } from "../policy.js";
import { expect, VerificationError, type Facts } from "../types.js";
import type { VerificationWorkspace } from "../workspace.js";

const send = (message: Facts) => process.send?.(message);

/** Only loaded by the owned verification Pi process, never the package manifest. */
export default async function (pi: ExtensionAPI) {
	expect(process.send && process.env.BRIDGE_VERIFY_WORKSPACE, "owned-verification-process-required");
	const workspace = JSON.parse(process.env.BRIDGE_VERIFY_WORKSPACE!) as VerificationWorkspace;
	let apiCalls = 0;
	const context = {
		appDir: fileURLToPath(new URL("../../../", import.meta.url)), modelId: MODEL_ID, isLive: true,
		get apiCalls() { return apiCalls; },
		set apiCalls(value: number) { send({ kind: "bridge-verification-api-call", count: value - apiCalls }); apiCalls = value; },
	};
	let resolveReady!: (runner: LiveRunner) => void;
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<LiveRunner>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	let finish!: () => void;
	const finished = new Promise<void>(resolve => { finish = resolve; });
	let currentContext: ExtensionContext | undefined;
	let startingBranchLinkCount = 0;
	const linkCount = () => currentContext?.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "claude-bridge-cc-session").length ?? 0;
	const observedQueries: Facts[] = [];
	const engine = withLiveRunner(context, async runner => {
		resolveReady(runner);
		await finished;
		const deadlineMs = Date.now() + 10000;
		while (__test.activeQueryContexts.size && Date.now() < deadlineMs) await delay(10);
		expect(__test.activeQueryContexts.size === 0, "pi-query-did-not-settle");
		return {
			piSessionId: currentContext?.sessionManager.getSessionId(), startingBranchLinkCount, finishingBranchLinkCount: linkCount(),
			finalMirror: __test.getSharedSession(currentContext?.sessionManager.getSessionId()),
			queries: observedQueries,
			capturedPrefixes: runner.requests.map(request => captureRequestPrefix(runner.payloadFor(request))),
			capturedShapePrefixes: runner.requests.map(request => captureRequestPrefix(runner.payloadFor(request), false)),
			requestShapes: runner.requests.map(request => messageShapes(runner.payloadFor(request))),
			modelContextContainsLinkEntry: runner.requests.some(request => JSON.stringify(runner.payloadFor(request)).includes("claude-bridge-cc-session")),
		};
	}, 240000, options => options, workspace,
		process.env.BRIDGE_VERIFY_INTERVENTION === "system-text-blocks" ? systemTextAsBlocks : undefined);
	void engine.catch(rejectReady);
	const runner = await ready;
	bridge(pi);
	__test.setQuery(input => {
		observedQueries.push({ resume: input.options?.resume ?? null });
		return runner.harness.runtime.invokeQuery(input);
	});
	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		startingBranchLinkCount = linkCount();
		send({ kind: "bridge-verification-ready", piSessionId: ctx.sessionManager.getSessionId() });
	});
	let isFinishing = false;
	process.on("message", async message => {
		if (!message || typeof message !== "object" || (message as Facts).kind !== "bridge-verification-finish" || isFinishing) return;
		isFinishing = true;
		finish();
		try {
			const observed = await engine;
			send({ kind: "bridge-verification-result", apiCalls: context.apiCalls, observed });
		} catch (error) {
			send({ kind: "bridge-verification-error", apiCalls: context.apiCalls, code: error instanceof VerificationError ? error.code : "pi-verification-failed" });
		} finally {
			__test.setQuery(() => { throw new VerificationError("verification-process-finished"); });
		}
	});
}
