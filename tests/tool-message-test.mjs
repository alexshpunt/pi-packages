#!/usr/bin/env node
// Integration tests for tool execution + message interaction scenarios.
// Uses pi in RPC mode with the bridge + SlowTool test extension.
// Exercises how the bridge handles messages arriving during tool execution.

console.log("=== tool-message-test.mjs ===");

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOGDIR = `${DIR}/.test-output`;
mkdirSync(LOGDIR, { recursive: true });
const RPC_LOG = `${LOGDIR}/tool-message.log`;
const DEBUG_LOG = `${LOGDIR}/tool-message-debug.log`;
const TEST_TIMEOUT = 30_000;

// Strip node_modules/.bin from PATH
process.env.PATH = process.env.PATH
	.split(":")
	.filter((p) => !p.includes("node_modules"))
	.join(":");

// --- Pi RPC harness ---

let pi, buffer, listeners, reqId, rpcLog;

function startPi() {
	rpcLog = createWriteStream(RPC_LOG, { flags: "a" });
	buffer = "";
	listeners = [];
	reqId = 0;

	pi = spawn("pi", [
		"--no-session", "-ne",
		"-e", DIR,
		"-e", `${DIR}/tests/slow-tool-extension.ts`,
		"--model", "claude-bridge/claude-haiku-4-5",
		"--mode", "rpc",
	], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, CLAUDE_BRIDGE_DEBUG: "1", CLAUDE_BRIDGE_DEBUG_PATH: DEBUG_LOG },
	});

	pi.stderr.on("data", (d) => rpcLog.write(d));

	const decoder = new StringDecoder("utf8");
	pi.stdout.on("data", (chunk) => {
		buffer += decoder.write(chunk);
		while (true) {
			const i = buffer.indexOf("\n");
			if (i === -1) break;
			const line = buffer.slice(0, i);
			buffer = buffer.slice(i + 1);
			try {
				const msg = JSON.parse(line);
				rpcLog.write(`< ${line}\n`);
				for (const fn of listeners) fn(msg);
			} catch {}
		}
	});
}

function stopPi() {
	pi.kill();
	return new Promise((r) => rpcLog.end(r));
}

function send(cmd) {
	const id = `req_${++reqId}`;
	const full = { ...cmd, id };
	rpcLog.write(`> ${JSON.stringify(full)}\n`);
	pi.stdin.write(JSON.stringify(full) + "\n");
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timeout: ${cmd.type}`)), TEST_TIMEOUT);
		listeners.push(function handler(msg) {
			if (msg.type === "response" && msg.id === id) {
				clearTimeout(timer);
				listeners.splice(listeners.indexOf(handler), 1);
				if (msg.success) resolve(msg.data);
				else reject(new Error(`${cmd.type}: ${msg.error}`));
			}
		});
	});
}

function waitForEvent(type, timeout = TEST_TIMEOUT) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
		listeners.push(function handler(msg) {
			if (msg.type === type) {
				clearTimeout(timer);
				listeners.splice(listeners.indexOf(handler), 1);
				resolve(msg);
			}
		});
	});
}

function waitForMatch(predicate, description, timeout = TEST_TIMEOUT) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${description}`)), timeout);
		listeners.push(function handler(msg) {
			if (predicate(msg)) {
				clearTimeout(timer);
				listeners.splice(listeners.indexOf(handler), 1);
				resolve(msg);
			}
		});
	});
}

function collectText() {
	let text = "";
	const handler = (msg) => {
		if (msg.type === "message_update") {
			const ae = msg.assistantMessageEvent;
			if (ae?.type === "text_delta") text += ae.delta;
		}
	};
	listeners.push(handler);
	return { stop() { listeners.splice(listeners.indexOf(handler), 1); return text; } };
}

async function promptAndWait(message, timeout = TEST_TIMEOUT) {
	const collector = collectText();
	await send({ type: "prompt", message });
	await waitForEvent("agent_end", timeout);
	return collector.stop();
}

// --- Test runner ---

let pass = 0, fail = 0;

async function test(name, fn) {
	process.stdout.write(`  ${name} ... `);
	try {
		await fn();
		console.log("PASS");
		pass++;
	} catch (e) {
		console.log(`FAIL: ${e.message}`);
		fail++;
		// Restart pi after failure — failed test may have left it stuck
		await stopPi();
		startPi();
		await new Promise((r) => setTimeout(r, 2000));
	}
}

// --- Tests ---

startPi();
await new Promise((r) => setTimeout(r, 2000));

await test("tool call completes normally", async () => {
	const text = await promptAndWait(
		"Call SlowTool with seconds=1. Then repeat exactly what it returned, nothing else."
	);
	if (!text.toLowerCase().includes("slowtool completed"))
		throw new Error(`Expected tool result in response: ${text.slice(0, 200)}`);
});

await test("followUp during tool execution delivers after tool completes", async () => {
	const collector = collectText();
	await send({
		type: "prompt",
		message: "Call SlowTool with seconds=5. Then repeat exactly what it returned.",
	});
	await waitForEvent("tool_execution_start");
	// followUp is queued by pi until the current turn finishes
	await send({
		type: "prompt",
		message: "This is a followUp during tool execution.",
		streamingBehavior: "followUp",
	});
	await waitForEvent("agent_end");
	const text = collector.stop();
	if (!text.toLowerCase().includes("slowtool completed"))
		throw new Error(`Expected tool result in response: ${text.slice(0, 200)}`);
});

await test("steer during tool execution still delivers tool result", async () => {
	// Issue #3: steer injects a user message into the context during an active
	// tool call. extractAllToolResults stops at the user message and returns 0
	// results, leaving the pending handler stuck.
	const collector = collectText();
	await send({
		type: "prompt",
		message: "Call SlowTool with seconds=2. Then repeat exactly what it returned.",
	});
	await waitForEvent("tool_execution_start");
	await send({
		type: "prompt",
		message: "This is a steer message during tool execution.",
		streamingBehavior: "steer",
	});
	await waitForEvent("agent_end", 15_000);
	const text = collector.stop();
	if (!text.toLowerCase().includes("slowtool completed"))
		throw new Error(`Expected tool result in response: ${text.slice(0, 200)}`);
});

await test("parallel tool calls with steer delivers all results", async () => {
	const collector = collectText();
	await send({
		type: "prompt",
		message: "Call SlowTool three times in parallel: seconds=3, seconds=4, seconds=5. Then list all three results.",
	});
	// Wait for at least one tool to start, then inject steer
	await waitForEvent("tool_execution_start");
	await send({
		type: "prompt",
		message: "This is a steer during parallel tool execution.",
		streamingBehavior: "steer",
	});
	await waitForEvent("agent_end", 30_000);
	const text = collector.stop();
	// All three tools should have their results in the response
	const matches = (text.match(/slowtool completed/gi) || []).length;
	if (matches < 3)
		throw new Error(`Expected 3 SlowTool results, found ${matches}: ${text.slice(0, 300)}`);
});


await test("steer during tool execution is visible to assistant", async () => {
	// Bug: when a steer arrives during tool execution, pi drains it at the turn
	// boundary and injects it into context alongside the tool result. The bridge
	// sees activeQuery=true, enters tool-result-delivery mode, extracts the tool
	// result, but silently ignores the trailing user message (the steer). Claude
	// never sees the steer content.
	const collector = collectText();
	await send({
		type: "prompt",
		message: "Call SlowTool with seconds=2. After it returns, repeat exactly what it returned.",
	});
	await waitForEvent("tool_execution_start");
	await send({
		type: "prompt",
		message: "IMPORTANT: Also say the exact word 'MANGO' on its own line in your response.",
		streamingBehavior: "steer",
	});
	await waitForEvent("agent_end", 20_000);
	const text = collector.stop();
	if (!text.toLowerCase().includes("mango"))
		throw new Error(`Steer content not visible to assistant (expected 'mango'): ${text.slice(0, 300)}`);
});

await test("abort during tool execution recovers cleanly", async () => {
	await send({
		type: "prompt",
		message: "Call SlowTool with seconds=30.",
	});
	await waitForEvent("tool_execution_start");
	const idle = waitForEvent("agent_end");
	await send({ type: "abort" });
	await idle;
	// Next prompt should work without hanging
	const text = await promptAndWait("Reply with just the word 'recovered'.");
	if (!text.toLowerCase().includes("recovered"))
		throw new Error(`Expected 'recovered' in response: ${text.slice(0, 200)}`);
});

await stopPi();

// --- Summary ---

console.log(`\n  RPC log: ${RPC_LOG}`);
console.log(`  Debug log: ${DEBUG_LOG}`);
console.log(`\nPassed: ${pass}  Failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
