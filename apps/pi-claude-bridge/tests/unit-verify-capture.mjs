import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
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
	assert.deepEqual(flagValues(["--model=one", "--model", "two"], "model"), ["one", "two"]);
	assert.deepEqual(flagValues(["--tools", "", "--strict-mcp-config", "--model=one"], "tools"), [""]);
	assert.deepEqual(flagValues(["--strict-mcp-config", "--model=one"], "strict-mcp-config"), [null]);
});

test("shared capture transport preserves bytes, forwarding headers and cache usage", async () => {
	const originalFetch = globalThis.fetch;
	const body = JSON.stringify({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "fixture" }] });
	const sse = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 } } })}\n\n`;
	let exchange;
	globalThis.fetch = async (url, options) => {
		assert.equal(url, "https://api.anthropic.com/v1/messages?beta=true");
		assert.equal(options.body.toString(), body);
		assert.equal(options.headers.host, undefined);
		assert.equal(options.headers["content-length"], undefined);
		assert.equal(options.headers["accept-encoding"], undefined);
		assert.equal(options.headers.authorization, "Bearer fixture");
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const server = createCaptureServer({ onExchange(value) { exchange = value; } });
	try {
		const response = await post(await listen(server), body, { authorization: "Bearer fixture", "accept-encoding": "gzip" });
		assert.equal(response.status, 200);
		assert.equal(response.text, sse);
		assert.equal(exchange.n, 1);
		assert.equal(exchange.body.toString(), body);
		assert.deepEqual(usageFromSse(exchange.text), { input: 3, cacheRead: 5, cacheWrite: 7 });
	} finally { await close(server); globalThis.fetch = originalFetch; }
});

test("capture request guards reject before any upstream request", async () => {
	const originalFetch = globalThis.fetch;
	let forwards = 0;
	let rejections = 0;
	globalThis.fetch = async () => { forwards++; throw new Error("must not forward"); };
	const server = createCaptureServer({ beforeForward() { throw new Error("fixture guard"); }, onRejected() { rejections++; } });
	try {
		assert.equal((await post(await listen(server), "{}")).status, 403);
		assert.equal(forwards, 0);
		assert.equal(rejections, 1);
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
		assert.equal((await post(port, JSON.stringify(payload), { authorization: "Bearer fixture-secret-material" })).status, 400);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepEqual(JSON.parse(readFileSync(join(out, "req-0001.json"), "utf8")), payload);
		const error = JSON.parse(readFileSync(join(out, "err-0001.json"), "utf8"));
		assert.equal(error.status, 400);
		assert.equal(error.requestHeaders.authorization, "Bearer fixture-secr…");
		assert.equal(JSON.parse(error.responseBody).error.message, "fixture rejection");
		const index = JSON.parse(readFileSync(join(out, "index.jsonl"), "utf8"));
		assert.equal(index.model, payload.model);
		assert.equal(index.messages, 1);
		assert.equal(index.auth, error.requestHeaders.authorization);
	} finally {
		if (child.exitCode === null) child.kill("SIGTERM");
		await exited;
		rmSync(root, { recursive: true, force: true });
	}
});
