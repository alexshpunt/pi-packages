import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Options, Query, SDKMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { createCaptureServer, usageFromSse } from "../../diag/lib/capture-http.mjs";
import { createSdkQueryClient } from "../../src/adapters/claude/client.js";
import { createHarness } from "./harness.js";
import { assertLiveEnvironment, assertSubscriptionAccount, MODEL_ID } from "./policy.js";
import { fingerprint, versions } from "./report.js";
import { EnvironmentError, expect, VerificationError, type CheckContext, type Facts } from "./types.js";
import { withWorkspace, type VerificationWorkspace } from "./workspace.js";

export interface CapturedRequest {
	sequence: number;
	model: string;
	input: ReturnType<typeof fingerprint>;
	messageCount: number;
	toolCount: number;
	status: number | null;
	isResponseComplete: boolean;
	isResponseAborted: boolean;
	usage: { input: number; cacheRead: number; cacheWrite: number } | null;
}

export type ResultFault = "error-result" | "exception" | "process-exit";
export type ExpectedTurnOutcome = "success" | "error" | "aborted";

export interface LiveRunner {
	workspace: VerificationWorkspace;
	harness: ReturnType<typeof createHarness>;
	requests: CapturedRequest[];
	inits: Facts[];
	sdkResults: Facts[];
	turn(context: Context, options?: SimpleStreamOptions, expectedOutcome?: ExpectedTurnOutcome): ReturnType<ReturnType<typeof createHarness>["turn"]>;
	/** Inject a controlled SDK failure after the next real response; no auth/init rewriting. */
	faultNextResult(fault: ResultFault): void;
	/** Drop only this owned capture server's connections; never abort the caller signal. */
	disconnectResponses(): void;
	queryOptions(): readonly Options[];
	/** Private input for fidelity assertions. Never include it in a report. */
	payloadFor(request: CapturedRequest): Record<string, unknown>;
}

export async function withLiveRunner(
	context: CheckContext,
	run: (runner: LiveRunner) => Promise<Facts>,
	timeoutMs = 180000,
	configureOptions: (options: Options) => Options = options => options,
	ownedWorkspace?: VerificationWorkspace,
	/** Diagnostic intervention on the model request body; returns the same object when unchanged. */
	transformPayload?: (payload: Record<string, unknown>) => Record<string, unknown>,
	transport: { shouldStreamResponses?: boolean; onSdkMessage?: (message: SDKMessage) => void } = {},
): Promise<Facts> {
	if (!context.isLive) throw new EnvironmentError("live-query-not-authorized");
	assertLiveEnvironment(process.env, context.modelId);
	const runInWorkspace = async (workspace: VerificationWorkspace): Promise<Facts> => {
		const harness = createHarness(workspace, context.modelId);
		const client = createSdkQueryClient();
		const requests: CapturedRequest[] = [];
		const inits: Facts[] = [];
		const sdkResults: Facts[] = [];
		const injectedFaults: Facts[] = [];
		let nextResultFault: ResultFault | undefined;
		const inputs: Options[] = [];
		const payloads = new WeakMap<CapturedRequest, Record<string, unknown>>();
		const bySequence = new Map<number, CapturedRequest>();
		const active = new Set<Query>();
		const authGates: Promise<void>[] = [];
		const authChecks: Facts[] = [];
		const expectedVersion = versions(context.appDir).claudeCode;
		let fatal: VerificationError | undefined;
		const deadline = new AbortController();
		const fail = (error: VerificationError) => {
			fatal ??= error;
			for (const query of active) query.close();
		};
		const server = createCaptureServer({
			maxRequestBytes: 32 * 1024 * 1024,
			abortOnDisconnect: true,
			shouldStreamResponses: transport.shouldStreamResponses ?? false,
			async beforeForward(request) {
				if (request.method !== "POST" || request.path?.split("?")[0] !== "/v1/messages") return;
				if (fatal) throw fatal;
				const received = JSON.parse(request.body.toString("utf8"));
				if (received.model !== MODEL_ID && received.model !== `${MODEL_ID}[1m]`) throw new EnvironmentError("non-haiku-request-blocked");
				const payload = transformPayload?.(received) ?? received;
				if (payload !== received) {
					if (payload.model !== received.model) throw new EnvironmentError("intervention-changed-model");
					request.body = Buffer.from(JSON.stringify(payload));
				}
				// Inspect only in memory. Neither headers nor token families enter observations.
				if (request.headers["x-api-key"] !== undefined || !/^Bearer sk-ant-oat\d+-/i.test(String(request.headers.authorization ?? "")))
					throw new EnvironmentError("non-subscription-request-blocked");
				await Promise.all(authGates);
				if (fatal) throw fatal;
				const captured: CapturedRequest = {
					sequence: request.n, model: payload.model, input: fingerprint(request.body),
					messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
					toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
					status: null, usage: null, isResponseComplete: false, isResponseAborted: false,
				};
				payloads.set(captured, payload);
				requests.push(captured);
				bySequence.set(request.n, captured);
				context.apiCalls++;
			},
			onRejected(error) { fail(error instanceof VerificationError ? error : new VerificationError("request-guard-failed")); },
			onError() { fail(new VerificationError("capture-upstream-failed")); },
			onExchange(exchange) {
				const captured = bySequence.get(exchange.n);
				if (captured) {
					captured.status = exchange.status;
					captured.usage = usageFromSse(exchange.text);
					captured.isResponseAborted = exchange.isAborted === true;
					captured.isResponseComplete = !captured.isResponseAborted;
				}
			},
		});
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		harness.runtime.setQuery(input => {
			if (fatal) throw fatal;
			// Verification-only settings/env controls still pass through the same
			// subscription, model, version, timeout, and capture gates below.
			const options = configureOptions(input.options ?? {});
			inputs.push(options);
			const resultFault = nextResultFault;
			nextResultFault = undefined;
			let nativeExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
			let nativeProcess: SpawnedProcess | undefined;
			const actual = client.invokeQuery({ ...input, options: {
				...options, env: { ...options.env, ANTHROPIC_BASE_URL: url },
				stderr: options.stderr ?? (() => {}),
				...(["exception", "process-exit"].includes(resultFault ?? "") ? { spawnClaudeCodeProcess(parameters) {
					const child: SpawnedProcess = options.spawnClaudeCodeProcess?.(parameters) ?? (() => {
						const spawned = spawn(parameters.command, parameters.args, { cwd: parameters.cwd, env: parameters.env, signal: parameters.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
						spawned.stderr.on("data", data => options.stderr?.(data.toString()));
						return spawned;
					})();
					nativeExit = new Promise((resolve, reject) => {
						child.once("exit", (code, signal) => resolve({ code, signal }));
						child.once("error", reject);
					});
					void nativeExit.catch(() => {});
					nativeProcess = child;
					return child;
				} } satisfies Partial<Options> : {}),
			} });
			active.add(actual);
			const auth = actual.accountInfo().then(account => {
				authChecks.push({ apiKeySource: account.apiKeySource ?? "unreported", apiProvider: account.apiProvider ?? "unreported" });
				assertSubscriptionAccount(account);
			}).catch(error => {
				const failure = error instanceof VerificationError ? error : new EnvironmentError("account-initialization-failed");
				fail(failure);
				throw failure;
			});
			void auth.catch(() => {});
			authGates.push(auth);
			const stream = (async function* () {
				let hasKilledProcess = false;
				try {
					for await (const message of actual) {
						if (message.type === "system" && message.subtype === "init") {
							inits.push({ apiKeySource: message.apiKeySource, model: message.model, claudeCode: message.claude_code_version, permissionMode: message.permissionMode, tools: message.tools });
							if (message.apiKeySource !== "none") fail(new EnvironmentError("subscription-init-required"));
							if (![MODEL_ID, `${MODEL_ID}[1m]`].includes(message.model)) fail(new EnvironmentError("non-haiku-init"));
							if (message.claude_code_version !== expectedVersion) fail(new EnvironmentError("claude-code-version-mismatch"));
						}
						if (message.type === "result") sdkResults.push({ subtype: message.subtype, isError: message.is_error, modelUsage: Object.entries(message.modelUsage ?? {}).map(([model, usage]) => ({
							model, contextWindow: usage.contextWindow, maxOutputTokens: usage.maxOutputTokens,
							inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadInputTokens: usage.cacheReadInputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens,
						})) });
						if (message.type === "result" && (resultFault === "error-result" || resultFault === "exception")) {
							await auth;
							if (resultFault === "exception") {
								actual.close();
								expect(nativeExit, "native-process-exit-not-observable");
								const exit = await nativeExit;
								injectedFaults.push({ kind: resultFault, nativeProcessExited: true, ...exit });
								throw new Error("Controlled verification query exception");
							}
							injectedFaults.push({ kind: resultFault, originalResult: message.subtype });
							yield { ...message, subtype: "error_during_execution" as const, is_error: true, errors: ["Controlled verification error result"] };
							continue;
						}
						transport.onSdkMessage?.(message);
						yield message;
						if (resultFault === "process-exit" && !hasKilledProcess && message.type === "stream_event" &&
							message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
							expect(nativeProcess && nativeExit && !requests.at(-1)?.isResponseComplete, "native-process-exit-not-inflight");
							hasKilledProcess = true;
							nativeProcess.kill("SIGKILL");
							const exit = await nativeExit;
							injectedFaults.push({ kind: resultFault, nativeProcessExited: true, ...exit });
						}
					}
				} finally { active.delete(actual); }
			})();
			// Preserve the real SDK object's methods and their private-field receiver.
			return new Proxy(actual, { get(target, key) {
				if (key === Symbol.asyncIterator) return () => stream;
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			} });
		});
		const timeout = setTimeout(() => { deadline.abort(); fail(new VerificationError("live-check-timeout")); }, timeoutMs);
		const metadata = (): Facts => ({ apiKeySource: inits.length && inits.every(init => init.apiKeySource === "none") ? "none" : "unconfirmed", model: MODEL_ID, nativeModel: harness.cliModel, authChecks, inits, requests, sdkResults, injectedFaults });
		let observed: Facts | undefined;
		let failure: unknown;
		try {
			observed = await run({ workspace, harness, requests, inits, sdkResults,
				async turn(input, options = {}, expectedOutcome = "success") {
					const result = await harness.turn(input, { ...options, signal: options.signal ?? deadline.signal });
					if (fatal) throw fatal;
					expect(expectedOutcome === "success" ? result.stopReason !== "error" && result.stopReason !== "aborted" : result.stopReason === expectedOutcome, "live-provider-turn-outcome-mismatch");
					return result;
				},
				faultNextResult(fault) { expect(!nextResultFault, "verification-fault-already-armed"); nextResultFault = fault; },
				disconnectResponses() { server.closeAllConnections(); },
				queryOptions: () => inputs,
				payloadFor: request => payloads.get(request)!,
			});
			await harness.waitForIdle();
			await Promise.all(authGates);
			if (fatal) throw fatal;
			expect(inits.length > 0 && inits.length === inputs.length, "sdk-init-observation-incomplete");
		} catch (error) { failure = error; }
		finally {
			clearTimeout(timeout);
			for (const query of active) query.close();
			try { await harness.close(); } catch (error) { failure ??= error; }
			await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
		}
		if (failure) {
			const error = failure instanceof VerificationError ? failure : new VerificationError("live-check-failed");
			Object.assign(error.observed, metadata());
			throw error;
		}
		return { ...observed, ...metadata() };
	};
	// A caller-supplied workspace is owned and cleaned by the outer verification
	// process, allowing two actual Pi processes to use one temporary session tree.
	return ownedWorkspace ? runInWorkspace(ownedWorkspace) : withWorkspace(true, runInWorkspace);
}
