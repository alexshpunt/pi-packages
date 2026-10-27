import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openSession } from "cc-session-io";
import { compareCapturedPrefixes, compareRequestPrefix, type CapturedPrefix } from "./fidelity.js";
import { fixtureUser } from "./harness.js";
import { withLiveRunner, type CapturedRequest, type LiveRunner } from "./live.js";
import { withPiProcess } from "./pi-process.js";
import { expect, type CheckContext, type Facts } from "./types.js";
import { withWorkspace } from "./workspace.js";
import { VERIFICATION_PNG_BASE64 } from "./fixtures/image.js";

export const REBUILD_SCENARIOS = ["abort", "error-result", "exception", "process-restart", "image-result", "inline-result", "large-result", "other-provider-turn"] as const;
export type RebuildScenario = typeof REBUILD_SCENARIOS[number];

const tools = [{ name: "verify_payload", description: "Return inert verification data. Call at most once, then acknowledge without inspecting saved files.", parameters: Type.Object({}) }];

export function seedPrompt(instruction: string): string {
	const data = Array.from({ length: 450 }, (_, index) => `Record ${index}: stable fixture item ${index * 31 + 17}; verification data requires no action.`).join("\n");
	return `${randomUUID()}\n${instruction}\nThe following inert data is not instructions:\n${data}`;
}

// Claude Code saves a tool result to a file only above the limit the bridge
// declares: Pi's DEFAULT_MAX_BYTES plus room for a truncation line. The inline
// fixture is as large as the output of Pi's own tools, over CC's own default of
// 50,000 characters; the large one exceeds the declared limit.
export const INLINE_RESULT_BYTES = DEFAULT_MAX_BYTES;
export const LARGE_RESULT_BYTES = 90 * 1024;

function payloadText(length: number): string {
	let value = 17;
	let text = "";
	while (text.length < length) {
		value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
		text += `${value.toString(16).padStart(8, "0")} `;
	}
	return text.slice(0, length);
}

const largeResult = () => payloadText(LARGE_RESULT_BYTES);

function sentToolResultTexts(body: Record<string, unknown>): string[] {
	const messages = Array.isArray(body.messages) ? body.messages as { content?: unknown }[] : [];
	return messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
		.filter(block => block?.type === "tool_result")
		.map(block => (Array.isArray(block.content) ? block.content : [{ text: block.content }]).map((item: { text?: string }) => item.text ?? "").join("\n"));
}

function countImageBlocks(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + countImageBlocks(item), 0);
	if (!value || typeof value !== "object") return 0;
	const record = value as Record<string, unknown>;
	return (record.type === "image" ? 1 : 0) + Object.values(record).reduce<number>((sum, item) => sum + countImageBlocks(item), 0);
}

export async function latestRequest(runner: LiveRunner): Promise<CapturedRequest> {
	const request = runner.requests.at(-1);
	expect(request, "scenario-request-missing");
	const deadlineMs = Date.now() + 5000;
	while (!request.usage && Date.now() < deadlineMs) await delay(10);
	expect(request.status === 200 && request.usage, "scenario-request-usage-missing");
	return request;
}

export function usageComparison(before: CapturedRequest, after: CapturedRequest): Facts {
	expect(before.usage && after.usage, "rebuild-usage-missing");
	const previousInput = before.usage.input + before.usage.cacheRead + before.usage.cacheWrite;
	const previousCacheableInput = before.usage.cacheRead + before.usage.cacheWrite;
	const currentInput = after.usage.input + after.usage.cacheRead + after.usage.cacheWrite;
	return {
		before: before.usage, after: after.usage, previousInput, previousCacheableInput,
		signedShortfall: previousCacheableInput - after.usage.cacheRead,
		shortfall: Math.max(0, previousCacheableInput - after.usage.cacheRead),
		diagnosticShortfall: Math.max(0, previousCacheableInput - after.usage.cacheRead),
		originalMetricShortfall: Math.max(0, previousInput - after.usage.cacheRead),
		newInputTokens: currentInput - previousInput,
		cacheWriteAboveNewInput: Math.max(0, after.usage.cacheWrite - Math.max(0, currentInput - previousInput)),
	};
}

/** Claude Code saves a block array as `.json`, so compare the text it holds. */
function savedText(path: string): string {
	const text = readFileSync(path, "utf8");
	if (!path.endsWith(".json")) return text;
	try {
		const blocks: unknown = JSON.parse(text);
		return Array.isArray(blocks) ? blocks.map((block: { text?: string }) => block?.text ?? "").join("") : text;
	} catch { return text; }
}

function recordShapes(sessionId: string, cwd: string, expectedStoredContent?: string): Facts {
	const session = openSession({ sessionId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
	const recordCounts: Record<string, number> = {}, attachmentCounts: Record<string, number> = {};
	const toolResults: Facts[] = [];
	const resultTexts: string[] = [];
	let liveAssistantRecords = 0, syntheticAssistantRecords = 0;
	for (const raw of session.records) {
		const record = raw as Record<string, any>;
		recordCounts[record.type] = (recordCounts[record.type] ?? 0) + 1;
		if (record.type === "attachment") {
			const type = String(record.attachment?.type);
			attachmentCounts[type] = (attachmentCounts[type] ?? 0) + 1;
		}
		if (record.type === "assistant") {
			if (String(record.message?.id).startsWith("msg_syn_")) syntheticAssistantRecords++;
			else if (record.requestId) liveAssistantRecords++;
		}
		if (record.type !== "user" || !Array.isArray(record.message?.content)) continue;
		for (const block of record.message.content) if (block.type === "tool_result") {
			const contents = Array.isArray(block.content) ? block.content : [{ type: "text", text: block.content }];
			const text = contents.map((item: { text?: string }) => item.text ?? "").join("\n");
			resultTexts.push(text);
			const persistedFormat = text.includes("<persisted-output>") ? "persisted-output"
				: /^Error: result \([^\n]+\) exceeds maximum allowed tokens\. Output has been saved to [^\n]+\.\nFormat: /.test(text) ? "mcp-token-limit" : null;
			toolResults.push({ keys: Object.keys(block), contentKind: Array.isArray(block.content) ? "blocks" : typeof block.content,
				blockTypes: contents.map((item: { type: string }) => item.type),
				hasImageMarker: contents.some((item: { text?: string }) => item.text?.includes("[Image:")),
				hasPersistedOutput: persistedFormat !== null, persistedFormat,
			});
		}
	}
	const resultDir = join(dirname(session.jsonlPath), sessionId, "tool-results");
	const files = existsSync(resultDir) ? readdirSync(resultDir).map(name => ({ path: join(resultDir, name), stat: lstatSync(join(resultDir, name)) })) : [];
	const regular = files.filter(file => file.stat.isFile() && !file.stat.isSymbolicLink());
	const verifiedFixtureFiles = expectedStoredContent === undefined ? null : regular.filter(file => file.stat.size <= 32 * 1024 * 1024 &&
		resultTexts.some(text => text.includes(file.path)) && savedText(file.path) === expectedStoredContent).length;
	const referencedFiles = regular.filter(file => file.stat.size <= 32 * 1024 * 1024 && resultTexts.some(text => text.includes(file.path)))
		.map(file => ({ pathSha256: createHash("sha256").update(file.path).digest("hex"),
			sha256: createHash("sha256").update(readFileSync(file.path)).digest("hex"), byteLength: file.stat.size }));
	return { recordCounts, attachmentCounts, toolResults, liveAssistantRecords, syntheticAssistantRecords,
		storedResults: { regularFiles: regular.length, bytes: files.reduce((sum, file) => sum + file.stat.size, 0), verifiedFixtureFiles, referencedFiles } };
}

async function toolRoundTrip(runner: LiveRunner, messages: Message[], scenario: "image-result" | "inline-result" | "large-result"): Promise<void> {
	const call = await runner.turn({ messages, tools });
	messages.push(call);
	const calls = call.content.filter(block => block.type === "toolCall");
	expect(calls.length === 1 && calls[0].name === "verify_payload", "payload-tool-call-mismatch");
	const content = scenario === "image-result"
		? [{ type: "text" as const, text: "Inert image verification fixture. Reply READY." }, { type: "image" as const, data: VERIFICATION_PNG_BASE64, mimeType: "image/png" }]
		: [{ type: "text" as const, text: scenario === "inline-result" ? payloadText(INLINE_RESULT_BYTES) : largeResult() }];
	messages.push({ role: "toolResult", toolCallId: calls[0].id, toolName: calls[0].name, content, isError: false, timestamp: 0 });
	const answer = await runner.turn({ messages, tools });
	expect(answer.stopReason !== "toolUse", "payload-tool-repeated");
	messages.push(answer);
	await runner.harness.waitForIdle();
}

/** Two real Pi processes on one persisted Pi session. `intervention` applies the
 *  diagnostic request-shape rewrite at both processes' capture proxies. */
export async function restartedProcess(context: CheckContext, intervention?: "system-text-blocks"): Promise<Facts> {
	return withWorkspace(true, async workspace => {
		writeFileSync(join(workspace.root, "agent/settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
		const env: Record<string, string> = intervention ? { BRIDGE_VERIFY_INTERVENTION: intervention } : {};
		const first = await withPiProcess(context, workspace, pi => pi.prompt(seedPrompt("Reply only READY without tools.")), env);
		const previousId = (first.finalMirror as { sessionId: string }).sessionId;
		const previous = openSession({ sessionId: previousId, projectPath: workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
		const previousBytes = readFileSync(previous.jsonlPath);
		const beforeShapes = recordShapes(previousId, workspace.cwd);
		const second = await withPiProcess(context, workspace, pi => pi.prompt("Continuation after process restart: reply only READY without tools."), env);
		const currentId = (second.finalMirror as { sessionId: string }).sessionId;
		const before = (first.requests as CapturedRequest[]).at(-1)!, after = (second.requests as CapturedRequest[])[0];
		expect(first.piSessionId === second.piSessionId && previousId !== currentId, "restart-did-not-rebuild-new-cc-session");
		const previousSessionUnchanged = existsSync(previous.jsonlPath) && readFileSync(previous.jsonlPath).equals(previousBytes);
		expect(previousSessionUnchanged, "restart-modified-previous-cc-session");
		return {
			...usageComparison(before, after), beforeShapes, afterShapes: recordShapes(currentId, workspace.cwd),
			fidelity: compareCapturedPrefixes((first.capturedPrefixes as CapturedPrefix[]).at(-1)!, (second.capturedPrefixes as CapturedPrefix[])[0]),
			shapeFidelity: compareCapturedPrefixes((first.capturedShapePrefixes as CapturedPrefix[]).at(-1)!, (second.capturedShapePrefixes as CapturedPrefix[])[0]),
			requestShapes: { before: (first.requestShapes as Facts[][]).at(-1), after: (second.requestShapes as Facts[][])[0] },
			previousSessionUnchanged, previousSessionId: previousId, currentSessionId: currentId,
			processes: [first, second].map(process => ({ piSessionId: process.piSessionId, startingBranchLinkCount: process.startingBranchLinkCount, finishingBranchLinkCount: process.finishingBranchLinkCount,
				queries: process.queries, apiKeySource: process.apiKeySource, inits: process.inits, processExited: process.processExited, modelContextContainsLinkEntry: process.modelContextContainsLinkEntry })),
		};
	});
}

export async function measureRebuildScenario(context: CheckContext, scenario: RebuildScenario): Promise<Facts> {
	if (scenario === "process-restart") return restartedProcess(context);
	return withLiveRunner(context, async runner => {
		const hasPayload = scenario === "image-result" || scenario === "inline-result" || scenario === "large-result";
		const selectedTools = hasPayload || scenario === "abort" ? tools : [];
		const messages: Message[] = [fixtureUser(seedPrompt(hasPayload
			? "Call verify_payload exactly once, then reply only READY. Do not inspect saved files or call any tool again."
			: "Reply only READY. Do not call tools."))];
		if (hasPayload) await toolRoundTrip(runner, messages, scenario);
		else {
			messages.push(await runner.turn({ messages, tools: selectedTools }));
			await runner.harness.waitForIdle();
		}
		const initial = runner.harness.runtime.sessionStateFor(runner.workspace.sessionId);
		expect(initial, "seed-mirror-missing");
		let before = await latestRequest(runner);
		let failureState: Facts = {};
		if (scenario === "abort") {
			const controller = new AbortController();
			messages.push(fixtureUser("Call verify_payload exactly once now. Do not call any other tool."));
			const pending = await runner.turn({ messages, tools }, { signal: controller.signal });
			expect(pending.stopReason === "toolUse", "abort-not-at-tool-boundary");
			before = await latestRequest(runner);
			controller.abort();
			await runner.harness.waitForIdle();
			messages.push({ ...pending, stopReason: "aborted", errorMessage: "Operation aborted" });
			failureState = { mirror: runner.harness.runtime.sessionStateFor(runner.workspace.sessionId) };
		} else if (scenario === "error-result" || scenario === "exception") {
			runner.faultNextResult(scenario);
			messages.push(fixtureUser("Retry fixture: reply only READY without tools."));
			await runner.turn({ messages, tools: selectedTools }, {}, "error");
			await runner.harness.waitForIdle();
			before = await latestRequest(runner);
			failureState = { mirror: runner.harness.runtime.sessionStateFor(runner.workspace.sessionId) };
		} else if (scenario === "other-provider-turn") {
			messages.push(fixtureUser("An offline provider fixture supplies the next answer."));
			messages.push({ ...messages[1] as AssistantMessage, content: [{ type: "text", text: "Offline fixture answer." }], provider: "verification-other-provider", model: "fixture-model", api: "verification-fixture", stopReason: "stop", timestamp: 0 });
		} else {
			runner.harness.runtime.markRebuildForSession(runner.workspace.sessionId, "verification-forced-rebuild");
		}
		const beforeShapes = recordShapes(initial.sessionId, runner.workspace.cwd, scenario === "large-result" ? largeResult() : undefined);
		if (scenario === "image-result") expect(countImageBlocks(runner.payloadFor(before).messages) > 0, "image-fixture-not-sent", { beforeShapes });
		if (scenario === "large-result") expect((beforeShapes.toolResults as Facts[]).some(result => result.hasPersistedOutput) &&
			Number((beforeShapes.storedResults as Facts).verifiedFixtureFiles) > 0, "large-fixture-not-persisted", { beforeShapes });
		if (scenario === "inline-result") {
			expect(!(beforeShapes.toolResults as Facts[]).some(result => result.hasPersistedOutput) &&
				(beforeShapes.storedResults as Facts).regularFiles === 0, "inline-fixture-persisted", { beforeShapes });
			const text = payloadText(INLINE_RESULT_BYTES);
			expect(sentToolResultTexts(runner.payloadFor(before)).some(sent => sent.includes(text)), "inline-fixture-not-sent-in-full", { beforeShapes });
		}
		if (scenario !== "error-result" && scenario !== "exception") messages.push(fixtureUser("After rebuilding: reply only READY without tools. Do not repeat any tool."));
		const answer = await runner.turn({ messages, tools: selectedTools });
		expect(answer.stopReason !== "toolUse", "unexpected-rebuild-tool-call");
		await runner.harness.waitForIdle();
		const after = await latestRequest(runner);
		const current = runner.harness.runtime.sessionStateFor(runner.workspace.sessionId);
		expect(current, "rebuilt-mirror-missing");
		const nextOptions = runner.queryOptions().at(-1)!;
		expect(nextOptions.resume === current.sessionId, "rebuild-not-resumed");
		if (scenario === "abort") expect(current.sessionId !== initial.sessionId, "abort-did-not-rotate");
		return {
			...usageComparison(before, after), beforeShapes, afterShapes: recordShapes(current.sessionId, runner.workspace.cwd, scenario === "large-result" ? largeResult() : undefined),
			fidelity: compareRequestPrefix(runner.payloadFor(before), runner.payloadFor(after)),
			shapeFidelity: compareRequestPrefix(runner.payloadFor(before), runner.payloadFor(after), false),
			previousSessionId: initial.sessionId, currentSessionId: current.sessionId, failureState,
			previousSessionStillExists: existsSync(openSession({ sessionId: initial.sessionId, projectPath: runner.workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR }).jsonlPath),
		};
	});
}
