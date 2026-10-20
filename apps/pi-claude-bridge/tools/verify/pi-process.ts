import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { EnvironmentError, expect, VerificationError, type CheckContext, type Facts } from "./types.js";
import { assertLiveEnvironment, MODEL_ID } from "./policy.js";
import type { VerificationWorkspace } from "./workspace.js";

interface PendingResponse { resolve: (value: Facts) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; }

/** A real Pi process with the production extension, guarded at its SDK query seam. */
export async function withPiProcess(
	context: CheckContext, workspace: VerificationWorkspace, run: (pi: { prompt(text: string): Promise<void> }) => Promise<void>,
	extraEnv: Record<string, string> = {},
): Promise<Facts> {
	if (!context.isLive) throw new EnvironmentError("live-query-not-authorized");
	assertLiveEnvironment(process.env, context.modelId);
	const child = spawn("pi", [
		"-ne", "-e", join(context.appDir, "tools/verify/fixtures/pi-process-extension.ts"),
		"-nt", "-ns", "-np", "--mode", "rpc", "--model", `claude-bridge/${MODEL_ID}`, "--thinking", "low",
		"--session-dir", join(workspace.root, "pi-sessions"), "--session-id", workspace.sessionId,
	], { cwd: workspace.cwd, env: { ...process.env, ...extraEnv, BRIDGE_VERIFY_WORKSPACE: JSON.stringify(workspace) }, stdio: ["pipe", "pipe", "pipe", "ipc"] });
	const responses = new Map<string, PendingResponse>();
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
	child.stderr.on("data", data => { stderrBytes += data.length; });
	child.on("message", raw => {
		if (!raw || typeof raw !== "object") return;
		const message = raw as Facts;
		if (message.kind === "bridge-verification-ready") {
			if (message.piSessionId !== workspace.sessionId) rejectReady(new VerificationError("pi-session-id-mismatch"));
			else resolveReady();
		}
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
	};
	child.once("error", () => {
		if (!child.pid) { hasExited = true; resolveExit(); }
		fail("pi-process-start-failed");
	});
	child.once("exit", () => { hasExited = true; resolveExit(); fail("pi-process-exited"); });
	const lines = createInterface({ input: child.stdout });
	lines.on("line", line => {
		let message: Facts;
		try { message = JSON.parse(line); } catch { return; }
		if (message.type === "response") {
			const pending = responses.get(String(message.id));
			if (pending) {
				clearTimeout(pending.timer); responses.delete(String(message.id));
				if (message.success) pending.resolve(message.data as Facts);
				else pending.reject(new VerificationError("pi-rpc-command-failed"));
			}
		}
		if (message.type === "message_end") {
			const assistant = message.message as Facts | undefined;
			if (assistant?.role === "assistant" && ["error", "aborted"].includes(String(assistant.stopReason))) rejectTurn?.(new VerificationError("pi-provider-turn-failed"));
		}
		if (message.type === "agent_end") resolveTurn?.();
	});
	function command(type: string, fields: Facts = {}): Promise<Facts> {
		const id = `verify-${++nextId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { responses.delete(id); reject(new VerificationError("pi-rpc-timeout")); }, 30000);
			responses.set(id, { resolve, reject, timer });
			child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
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
			async prompt(text) {
				const settled = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
				void settled.catch(() => {});
				try { await command("prompt", { message: text }); await settled; }
				finally { resolveTurn = undefined; rejectTurn = undefined; }
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
				await Promise.race([result.catch(() => {}), new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref(); })]);
			}
			child.kill("SIGTERM");
			const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
			await exited;
			clearTimeout(killTimer);
		}
		lines.close();
		for (const pending of responses.values()) clearTimeout(pending.timer);
	}
	if (failure) throw failure;
	expect(observed, "pi-observations-missing");
	return { ...observed, processExited: hasExited };
}
