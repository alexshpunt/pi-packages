import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { createSdkQueryClient } from "../../src/adapters/claude/client.js";
import { VerificationError, type Facts } from "./types.js";

/** Start the real CC against an owned rejecting endpoint, never a model service.
 * The local 400 response finishes deterministically instead of retrying a closed port.
 * Call only inside an offline verification workspace with synthetic credentials. */
export async function probeWithoutModel(options: Options, useApiKeyHelper = false): Promise<Facts> {
	let blockedRequestCount = 0;
	const endpoint = createServer((request, response) => {
		blockedRequestCount++;
		request.resume();
		response.writeHead(400, { "content-type": "application/json" });
		response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Verification endpoint: no model is available." } }));
	});
	await new Promise<void>((resolve, reject) => { endpoint.once("error", reject); endpoint.listen(0, "127.0.0.1", resolve); });
	const baseURL = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	const client = createSdkQueryClient();
	const env: NodeJS.ProcessEnv = { ...options.env, ANTHROPIC_BASE_URL: baseURL };
	if (!useApiKeyHelper) env.ANTHROPIC_API_KEY = "verification-invalid-key";
	let active: Query | undefined;
	let hasTimedOut = false;
	let hasInit = false;
	const hookEvents: string[] = [];
	let resultSubtype: string | undefined;
	let resultIsError: boolean | undefined;
	const timeout = setTimeout(() => { hasTimedOut = true; active?.close(); }, 20000);
	try {
		active = client.invokeQuery({ prompt: "Offline lifecycle verification. Reply briefly.", options: {
			...options, env,
			stderr: options.stderr ?? (() => {}),
		} });
		try {
			for await (const message of active) {
				if (message.type === "system" && message.subtype === "init") hasInit = true;
				if (message.type === "system" && message.subtype === "hook_started") hookEvents.push(message.hook_event);
				if (message.type === "result") { resultSubtype = message.subtype; resultIsError = message.is_error; }
			}
		} catch { /* Missing test auth or the deliberately rejected local request is expected. */ }
	} finally {
		clearTimeout(timeout);
		active?.close();
		await new Promise<void>(resolve => { endpoint.close(() => resolve()); endpoint.closeAllConnections(); });
	}
	if (hasTimedOut) throw new VerificationError("native-probe-timeout");
	return { hasInit, hookEvents, resultSubtype, resultIsError, blockedRequestCount, modelRequestsForwarded: 0, endpoint: "owned-loopback-rejector" };
}
