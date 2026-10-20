#!/usr/bin/env node
// Recording proxy for Claude Code's API traffic.
//
// The bridge passes process.env through to the CC child, and the shipped SDK
// honours ANTHROPIC_BASE_URL, so pointing that at this server captures the exact
// request bodies CC sends. That is the only way to see whether a `--resume`
// boundary re-sends a prompt prefix that differs from what CC sent live, which is
// the open ~25% cold-resume finding in diag/AUDIT.md.
//
//   node diag/capture-proxy.mjs [--port 8787] [--out DIR]
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8787 pi --model claude-bridge/...
//   node diag/diff-captures.mjs DIR
//
// Requests are written verbatim (they contain the conversation, so treat DIR as
// sensitive). Authorization headers are forwarded but only ever recorded as their
// key family (`sk-ant-oat01`, `sk-ant-api03`), which names the billing path a
// request took without writing credential material.
//
// A non-2xx also writes err-NNNN.json with the request headers, response headers
// and response body — the rate-limit and billing headers there are the record of
// what the server decided, and they are gone once the process exits.

import { createCaptureServer, usageFromSse } from "./lib/capture-http.mjs";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const PORT = Number(flag("port", 8787));
const OUT = flag("out", `/tmp/cc-capture-${process.pid}`);
const UPSTREAM = "https://api.anthropic.com";

mkdirSync(OUT, { recursive: true });
const INDEX = join(OUT, "index.jsonl");

/** Header set minus credential material. `authorization` is reduced to its key
 *  family so a capture still shows whether a request authenticated as a
 *  subscription (oat) or an API key (api), which changes how it is billed. */
function safeHeaders(headers) {
	const out = {};
	for (const [k, v] of Object.entries(headers)) {
		if (k === "authorization") out[k] = `${String(v).split(" ")[0]} ${String(v).split(" ")[1]?.slice(0, 12) ?? ""}…`;
		else if (k === "x-api-key") out[k] = `${String(v).slice(0, 12)}…`;
		else out[k] = v;
	}
	return out;
}

createCaptureServer({
	onError(error, { n }) {
		console.error(`[${n}] upstream failed: ${error.message}`);
	},
	onExchange({ n, body, headers, path, method, status, responseHeaders, text }) {
		let parsed = null;
		try { parsed = JSON.parse(body.toString("utf8")); } catch {}
		if (parsed) writeFileSync(join(OUT, `req-${String(n).padStart(4, "0")}.json`), JSON.stringify(parsed, null, 1));

		const requestHeaders = safeHeaders(headers);
		// /v1/ only: the SDK health-checks `/` with HEAD and takes the 404 in stride.
		if (status >= 300 && path.startsWith("/v1/")) {
			writeFileSync(join(OUT, `err-${String(n).padStart(4, "0")}.json`), JSON.stringify({
				n,
				at: new Date().toISOString(),
				status,
				path,
				requestHeaders,
				responseHeaders,
				responseBody: text,
			}, null, 1));
		}

		appendFileSync(INDEX, JSON.stringify({
			n,
			at: new Date().toISOString(),
			path,
			status,
			model: parsed?.model,
			messages: parsed?.messages?.length ?? null,
			tools: parsed?.tools?.length ?? null,
			usage: usageFromSse(text),
			betas: requestHeaders["anthropic-beta"] ?? null,
			auth: requestHeaders.authorization ?? requestHeaders["x-api-key"] ?? null,
		}) + "\n");
		const tag = status >= 300 ? ` ERROR → err-${String(n).padStart(4, "0")}.json` : "";
		console.error(`[${n}] ${method} ${path} → ${status} msgs=${parsed?.messages?.length ?? "-"}${tag}`);
	},
}).listen(PORT, "127.0.0.1", () => {
	console.error(`capture proxy on http://127.0.0.1:${PORT} → ${UPSTREAM}`);
	console.error(`writing to ${OUT}`);
});
