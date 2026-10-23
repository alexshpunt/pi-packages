import { spawn } from "node:child_process";
import { join } from "node:path";
import { EnvironmentError, expect, VerificationError, type CheckContext, type Facts } from "./types.js";
import { assertLiveEnvironment, MODEL_ID } from "./policy.js";
import type { VerificationWorkspace } from "./workspace.js";

interface PendingResponse { resolve: (value: Facts) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; }
interface EventWaiter extends PendingResponse { type: string; predicate?: (event: Facts) => boolean; }
export interface PiProcessDriver {
	prompt(text: string, options?: { isAbortExpected?: boolean; shouldAllowHostSetupAbortError?: boolean }): Promise<void>;
	command(type: string, fields?: Facts): Promise<Facts>;
	waitForEvent(type: string, predicate?: (event: Facts) => boolean): Promise<Facts>;
}

/** A real Pi process with the production extension, guarded at its SDK query seam. */
export async function withPiProcess(
	context: CheckContext, workspace: VerificationWorkspace, run: (pi: PiProcessDriver) => Promise<void>,
	extraEnv: Record<string, string> = {},
	fixtureName: "pi-process-extension.ts" | "lifecycle-process-extension.ts" = "pi-process-extension.ts",
): Promise<Facts> {
	if (!context.isLive) throw new EnvironmentError("live-query-not-authorized");
	assertLiveEnvironment(process.env, context.modelId);
	const child = spawn("pi", [
		"-ne", "-e", join(context.appDir, "tools/verify/fixtures", fixtureName),
		...(fixtureName === "lifecycle-process-extension.ts" ? ["--tools", "bridge_verify_wait"] : ["-nt"]),
		"-ns", "-np", "--mode", "rpc", "--model", `claude-bridge/${MODEL_ID}`, "--thinking", "low",
		"--session-dir", join(workspace.root, "pi-sessions"), "--session-id", workspace.sessionId,
	], { cwd: workspace.cwd, env: { ...process.env, ...extraEnv, BRIDGE_VERIFY_WORKSPACE: JSON.stringify(workspace) }, stdio: ["pipe", "pipe", "pipe", "ipc"] });
	const responses = new Map<string, PendingResponse>();
	const eventWaiters = new Set<EventWaiter>();
	let isAbortExpected = false;
	let shouldAllowHostSetupAbortError = false;
	let hostSetupAbortErrorCount = 0;
	let isLastTurnAborted = false;
	let processExitCode: number | null = null;
	let hasForcedTermination = false;
	let nextId = 0;
	let hasExited = false;
	let rejectTurn: ((error: Error) => void) | undefined;
	let resolveTurn: (() => void) | undefined;
	let resolveReady!: () => void, rejectReady!: (error: Error) => void;
	const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	let resolveResult!: (result: Facts) => void, rejectResult!: (error: Error) => void;
	const result = new Promise<Facts>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
	void result.catch(() => {});
	let resolveExit!: () => void;
	const exited = new Promise<void>(resolve => { resolveExit = resolve; });
	let stderrBytes = 0;
	let forwardedRequestCount = 0;
	// This owned process is always spawned with three pipe streams.
	child.stderr!.on("data", data => { stderrBytes += data.length; });
	child.on("message", raw => {
		if (!raw || typeof raw !== "object") return;
		const message = raw as Facts;
		if (message.kind === "bridge-verification-ready") {
			if (message.piSessionId !== workspace.sessionId) rejectReady(new VerificationError("pi-session-id-mismatch"));
			else resolveReady();
		}
		if (message.kind === "bridge-verification-finishing") child.stdin!.end();
		if (message.kind === "bridge-verification-api-call") {
			const count = Number(message.count);
			if (Number.isSafeInteger(count) && count > 0) { context.apiCalls += count; forwardedRequestCount += count; }
		}
		if (message.kind === "bridge-verification-result" || message.kind === "bridge-verification-error") {
			if (message.apiCalls !== forwardedRequestCount) { rejectResult(new VerificationError("pi-request-accounting-mismatch")); return; }
			if (message.kind === "bridge-verification-result") resolveResult(message.observed as Facts);
			else rejectResult(new VerificationError(String(message.code)));
		}
	});
	const fail = (code: string) => {
		const error = new VerificationError(code, { stderrBytes });
		rejectReady(error); rejectResult(error); rejectTurn?.(error);
		for (const pending of responses.values()) { clearTimeout(pending.timer); pending.reject(error); }
		responses.clear();
		for (const waiter of eventWaiters) { clearTimeout(waiter.timer); waiter.reject(error); }
		eventWaiters.clear();
	};
	child.once("error", () => {
		if (!child.pid) { hasExited = true; resolveExit(); }
		fail("pi-process-start-failed");
	});
	child.once("exit", code => { processExitCode = code; hasExited = true; resolveExit(); fail("pi-process-exited"); });
	const consumeRecord = (line: string) => {
		let message: Facts;
		try { message = JSON.parse(line); } catch { return; }
		if (message.type === "response") {
			const pending = responses.get(String(message.id));
			if (pending) {
				clearTimeout(pending.timer); responses.delete(String(message.id));
				if (message.success) pending.resolve((message.data as Facts | undefined) ?? {});
				else pending.reject(new VerificationError(String(message.error).startsWith("Nothing to compact") ? "pi-history-too-short-to-compact" : "pi-rpc-command-failed", { command: message.command }));
			}
		}
		if (message.type === "message_end") {
			const assistant = message.message as Facts | undefined;
			const isKnownHostSetupAbort = isAbortExpected && shouldAllowHostSetupAbortError && assistant?.role === "assistant" &&
				assistant.stopReason === "error" && assistant.errorMessage === "This operation was aborted" &&
				Array.isArray(assistant.content) && assistant.content.length === 0;
			if (isKnownHostSetupAbort) hostSetupAbortErrorCount++;
			else if (assistant?.role === "assistant" && (assistant.stopReason === "error" || assistant.stopReason === "aborted" && !isAbortExpected))
				rejectTurn?.(new VerificationError("pi-provider-turn-failed"));
		}
		if (message.type === "agent_settled") { isLastTurnAborted = message.aborted === true; resolveTurn?.(); }
		for (const waiter of eventWaiters) if (message.type === waiter.type && (!waiter.predicate || waiter.predicate(message))) {
			clearTimeout(waiter.timer); eventWaiters.delete(waiter); waiter.resolve(message);
		}
	};
	let buffered = "";
	child.stdout!.setEncoding("utf8");
	child.stdout!.on("data", (chunk: string) => {
		buffered += chunk;
		let newline: number;
		while ((newline = buffered.indexOf("\n")) >= 0) {
			consumeRecord(buffered.slice(0, newline));
			buffered = buffered.slice(newline + 1);
		}
	});
	function command(type: string, fields: Facts = {}): Promise<Facts> {
		const id = `verify-${++nextId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { responses.delete(id); reject(new VerificationError("pi-rpc-timeout")); }, 30000);
			responses.set(id, { resolve, reject, timer });
			child.stdin!.write(JSON.stringify({ id, type, ...fields }) + "\n");
		});
	}
	const startupTimeout = setTimeout(() => fail("pi-startup-timeout"), 15000);
	const deadline = setTimeout(() => { fail("pi-process-timeout"); child.kill("SIGTERM"); }, 250000);
	let observed: Facts | undefined;
	let failure: unknown;
	try {
		await ready;
		clearTimeout(startupTimeout);
		await run({
			command,
			waitForEvent(type, predicate) {
				const pending = new Promise<Facts>((resolve, reject) => {
					const waiter: EventWaiter = { type, predicate, resolve, reject, timer: setTimeout(() => {
						eventWaiters.delete(waiter); reject(new VerificationError("pi-event-timeout", { type }));
					}, 30000) };
					eventWaiters.add(waiter);
				});
				void pending.catch(() => {});
				return pending;
			},
			async prompt(text, options = {}) {
				isAbortExpected = options.isAbortExpected === true;
				shouldAllowHostSetupAbortError = options.shouldAllowHostSetupAbortError === true;
				isLastTurnAborted = false;
				const settled = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
				void settled.catch(() => {});
				try {
					const accepted = await command("prompt", { message: text });
					if (accepted.disposition !== "handled") await settled;
					expect(isLastTurnAborted === isAbortExpected, "pi-abort-outcome-mismatch");
				} finally { resolveTurn = undefined; rejectTurn = undefined; isAbortExpected = false; shouldAllowHostSetupAbortError = false; }
			},
		});
		child.send({ kind: "bridge-verification-finish" });
		observed = await result;
	} catch (error) { failure = error; }
	finally {
		clearTimeout(startupTimeout); clearTimeout(deadline);
		if (!hasExited) {
			if (!observed && child.connected) {
				child.send({ kind: "bridge-verification-finish" });
				await Promise.race([result.then(value => { observed = value; }).catch(() => {}), new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref(); })]);
			}
			child.stdin!.end();
			const terminateTimer = setTimeout(() => { hasForcedTermination = true; child.kill("SIGTERM"); }, 5000);
			const killTimer = setTimeout(() => child.kill("SIGKILL"), 10000);
			await exited;
			clearTimeout(terminateTimer); clearTimeout(killTimer);
		}
		for (const pending of responses.values()) clearTimeout(pending.timer);
		for (const waiter of eventWaiters) clearTimeout(waiter.timer);
	}
	if (failure) {
		if (failure instanceof VerificationError && observed) failure.observed.process = observed;
		throw failure;
	}
	expect(observed, "pi-observations-missing");
	expect(!hasForcedTermination && processExitCode === 0, "pi-process-did-not-exit-cleanly", { processExitCode, hasForcedTermination });
	return { ...observed, processExited: hasExited, processExitCode, hasForcedTermination, hostSetupAbortErrorCount };
}
