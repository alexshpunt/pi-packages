import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { createCaptureServer, usageFromSse } from "../diag/lib/capture-http.mjs";
import { flagValues } from "../tools/verify/spawn.js";

function post(port, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = request({ hostname: "127.0.0.1", port, path: "/v1/messages?beta=true", method: "POST", headers }, res => {
			const chunks = [];
			res.on("data", chunk => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		req.end(body);
	});
}
async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; }
async function close(server) { const done = once(server, "close"); server.close(); server.closeAllConnections(); await done; }

test("spawn argument parser supports typed, extraArgs, empty and flag-only forms", () => {
	expect(flagValues(["--model=one", "--model", "two"], "model")).toStrictEqual(["one", "two"]);
	expect(flagValues(["--tools", "", "--strict-mcp-config", "--model=one"], "tools")).toStrictEqual([""]);
	expect(flagValues(["--strict-mcp-config", "--model=one"], "strict-mcp-config")).toStrictEqual([null]);
});

test("shared capture transport preserves bytes, forwarding headers and cache usage", async () => {
	const originalFetch = globalThis.fetch;
	const body = JSON.stringify({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "fixture" }] });
	const sse = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 } } })}\n\n`;
	let exchange;
	globalThis.fetch = async (url, options) => {
		expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
		expect(options.body.toString()).toBe(body);
		expect(options.headers.host).toBe(undefined);
		expect(options.headers["content-length"]).toBe(undefined);
		expect(options.headers["accept-encoding"]).toBe(undefined);
		expect(options.headers.authorization).toBe("Bearer fixture");
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const server = createCaptureServer({ onExchange(value) { exchange = value; } });
	try {
		const response = await post(await listen(server), body, { authorization: "Bearer fixture", "accept-encoding": "gzip" });
		expect(response.status).toBe(200);
		expect(response.text).toBe(sse);
		expect(exchange.n).toBe(1);
		expect(exchange.body.toString()).toBe(body);
		expect(usageFromSse(exchange.text)).toStrictEqual({ input: 3, cacheRead: 5, cacheWrite: 7 });
	} finally { await close(server); globalThis.fetch = originalFetch; }
});

test("streaming capture forwards an early chunk before upstream completion and preserves split UTF-8", async () => {
	const originalFetch = globalThis.fetch;
	const bytes = Buffer.from("data: 한글 fixture\n\n");
	const split = Buffer.from("data: ").length + 1;
	let upstream;
	let exchange;
	globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
		upstream = controller;
		controller.enqueue(bytes.subarray(0, split));
	} }), { headers: { "content-type": "text/event-stream" } });
	const server = createCaptureServer({ shouldStreamResponses: true, abortOnDisconnect: true, onExchange(value) { exchange = value; } });
	try {
		const port = await listen(server);
		const observed = await new Promise((resolve, reject) => {
			let hasReceivedEarlyChunk = false;
			const chunks = [];
			const req = request({ hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST" }, res => {
				res.on("error", reject);
				res.on("data", chunk => {
					chunks.push(chunk);
					if (!hasReceivedEarlyChunk) {
						hasReceivedEarlyChunk = true;
						expect(exchange).toBeUndefined();
						upstream.enqueue(bytes.subarray(split));
						upstream.close();
					}
				});
				res.on("end", () => resolve({ hasReceivedEarlyChunk, text: Buffer.concat(chunks).toString("utf8") }));
			});
			req.on("error", reject);
			req.end("{}");
		});
		expect(observed).toStrictEqual({ hasReceivedEarlyChunk: true, text: bytes.toString("utf8") });
		expect(exchange.text).toBe(bytes.toString("utf8"));
		expect(exchange.isAborted).toBe(false);
	} finally { await close(server); globalThis.fetch = originalFetch; }
});

test("streaming capture cancels upstream on disconnect without reporting a server failure", async () => {
	const originalFetch = globalThis.fetch;
	let hasAborted = false;
	let errors = 0;
	let record;
	const recorded = new Promise(resolve => { record = resolve; });
	globalThis.fetch = async (_url, options) => new Response(new ReadableStream({ start(controller) {
		controller.enqueue(Buffer.from("data: partial\n\n"));
		options.signal.addEventListener("abort", () => {
			hasAborted = true;
			controller.error(new Error("fixture aborted"));
		}, { once: true });
	} }), { headers: { "content-type": "text/event-stream" } });
	const server = createCaptureServer({ shouldStreamResponses: true, abortOnDisconnect: true,
		onError() { errors++; }, onExchange(value) { record(value); } });
	try {
		const port = await listen(server);
		const req = request({ hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST" }, res => {
			res.once("data", () => res.destroy());
		});
		req.on("error", () => {});
		req.end("{}");
		const exchange = await recorded;
		expect(hasAborted).toBe(true);
		expect(exchange.isAborted).toBe(true);
		expect(exchange.text).toBe("data: partial\n\n");
		expect(errors).toBe(0);
	} finally { await close(server); globalThis.fetch = originalFetch; }
});

test("capture request guards reject before any upstream request", async () => {
	const originalFetch = globalThis.fetch;
	let forwards = 0;
	let rejections = 0;
	globalThis.fetch = async () => { forwards++; throw new Error("must not forward"); };
	const server = createCaptureServer({ beforeForward() { throw new Error("fixture guard"); }, onRejected() { rejections++; } });
	try {
		expect((await post(await listen(server), "{}")).status).toBe(403);
		expect(forwards).toBe(0);
		expect(rejections).toBe(1);
	} finally { await close(server); globalThis.fetch = originalFetch; }
});

test("existing capture-proxy CLI retains request, error and index files", async () => {
	const root = mkdtempSync(join(tmpdir(), "bridge-recorder-unit-"));
	const preload = join(root, "mock-fetch.mjs");
	const out = join(root, "captures");
	writeFileSync(preload, `globalThis.fetch = async () => new Response(JSON.stringify({error:{type:'invalid_request_error',message:'fixture rejection'}}), {status:400,headers:{'content-type':'application/json'}});\n`);
	const reservation = createServer();
	const port = await listen(reservation);
	await close(reservation);
	const child = spawn(process.execPath, ["--import", preload, resolve("diag/capture-proxy.mjs"), "--port", String(port), "--out", out], { stdio: ["ignore", "ignore", "pipe"] });
	const exited = once(child, "exit");
	try {
		await new Promise((resolve, reject) => {
			let text = "";
			const timeout = setTimeout(() => reject(new Error("capture proxy did not start")), 5000);
			child.once("error", error => { clearTimeout(timeout); reject(error); });
			child.stderr.on("data", chunk => { text += chunk; if (text.includes("capture proxy on")) { clearTimeout(timeout); resolve(); } });
		});
		const payload = { model: "claude-haiku-5-5", messages: [{ role: "user", content: "fixture only" }] };
		expect((await post(port, JSON.stringify(payload), { authorization: "Bearer fixture-secret-material" })).status).toBe(400);
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(JSON.parse(readFileSync(join(out, "req-0001.json"), "utf8"))).toStrictEqual(payload);
		const error = JSON.parse(readFileSync(join(out, "err-0001.json"), "utf8"));
		expect(error.status).toBe(400);
		expect(error.requestHeaders.authorization).toBe("Bearer fixture-secr…");
		expect(JSON.parse(error.responseBody).error.message).toBe("fixture rejection");
		const index = JSON.parse(readFileSync(join(out, "index.jsonl"), "utf8"));
		expect(index.model).toBe(payload.model);
		expect(index.messages).toBe(1);
		expect(index.auth).toBe(error.requestHeaders.authorization);
	} finally {
		if (child.exitCode === null) child.kill("SIGTERM");
		await exited;
		rmSync(root, { recursive: true, force: true });
	}
});
