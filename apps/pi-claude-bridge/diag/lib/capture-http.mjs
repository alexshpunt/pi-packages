import { createServer } from "node:http";
import { once } from "node:events";

/** Shared transport for the existing recording CLI and the verification runner.
 * Callers decide what to retain; credentials and request bodies are never logged here. */
export function createCaptureServer({ onExchange, onError, beforeForward, onRejected, maxRequestBytes = Infinity, abortOnDisconnect = false, shouldStreamResponses = false } = {}) {
	let sequence = 0;
	const controllers = new Set();
	const server = createServer((req, res) => {
		const chunks = [];
		let bytes = 0;
		req.on("data", chunk => {
			bytes += chunk.length;
			if (bytes > maxRequestBytes) { res.writeHead(413).end(); req.destroy(); return; }
			chunks.push(chunk);
		});
		req.on("end", async () => {
			const body = Buffer.concat(chunks);
			const n = ++sequence;
			const headers = { ...req.headers };
			delete headers.host;
			delete headers["content-length"];
			delete headers["accept-encoding"];
			const request = { n, method: req.method, path: req.url, body, headers };
			try { await beforeForward?.(request); }
			catch (error) {
				onRejected?.(error, request);
				if (!res.destroyed) res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Verification request rejected" }));
				return;
			}
			const controller = new AbortController();
			controllers.add(controller);
			if (abortOnDisconnect) res.once("close", () => { if (!res.writableEnded) controller.abort(); });
			let upstream;
			let text = "";
			const responseHeaders = {};
			const responseChunks = [];
			try {
				// beforeForward may replace request.body (verification interventions only).
				upstream = await fetch(`https://api.anthropic.com${req.url}`, {
					method: req.method, headers,
					body: ["GET", "HEAD"].includes(req.method) ? undefined : request.body,
					signal: controller.signal,
				});
				for (const [key, value] of upstream.headers) if (!["content-encoding", "content-length", "transfer-encoding"].includes(key)) responseHeaders[key] = value;
				if (shouldStreamResponses) {
					if (!res.destroyed) res.writeHead(upstream.status, responseHeaders);
					if (upstream.body) for await (const chunk of upstream.body) {
						responseChunks.push(Buffer.from(chunk));
						if (res.destroyed) break;
						if (!res.write(chunk)) await once(res, "drain", { signal: controller.signal });
					}
					text = Buffer.concat(responseChunks).toString("utf8");
					if (!res.destroyed) res.end();
				} else {
					text = await upstream.text();
					if (!res.destroyed) res.writeHead(upstream.status, responseHeaders).end(text);
				}
			} catch (error) {
				if (abortOnDisconnect && controller.signal.aborted && res.destroyed) {
					if (upstream) onExchange?.({ ...request, status: upstream.status, responseHeaders,
						text: Buffer.concat(responseChunks).toString("utf8"), isAborted: true });
					return;
				}
				// Keep the legacy buffered recorder's response-body failure behavior.
				if (upstream && !abortOnDisconnect && !shouldStreamResponses) throw error;
				onError?.(error, request);
				if (!res.destroyed) {
					if (res.headersSent) res.destroy(error);
					else res.writeHead(502).end(String(error.message));
				}
				return;
			} finally { controllers.delete(controller); }
			onExchange?.({ ...request, status: upstream.status, responseHeaders, text,
				...(shouldStreamResponses ? { isAborted: controller.signal.aborted } : {}) });
		});
	});
	server.once("close", () => { for (const controller of controllers) controller.abort(); });
	return server;
}

/** Existing cache-usage extraction, shared rather than copied into verification. */
export function usageFromSse(text) {
	const start = text.match(/^data: (\{"type":"message_start".*)$/m);
	if (!start) return null;
	try {
		const usage = JSON.parse(start[1]).message?.usage ?? {};
		return { input: usage.input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 };
	} catch { return null; }
}
