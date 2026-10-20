import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fixtureUser } from "../harness.js";
import { withLiveRunner } from "../live.js";
import { requestElements } from "../fidelity.js";
import { fingerprint } from "../report.js";
import { expect, type Facts, type VerificationCheck } from "../types.js";

const EMPTY_NOTE = "(mcp__custom-tools__verify_shape completed with no output)";
const ERROR_TEXT = "Controlled verification tool error";

function resultFor(body: Facts, id: string): Facts {
	const messages = body.messages as { content: unknown }[];
	const result = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === "tool_result" && block.tool_use_id === id);
	expect(result, "shape-tool-result-missing");
	const element = requestElements({ messages: [{ role: "user", content: [result] }] }).at(-1)!;
	return (element.value as { content: Facts[] }).content[0];
}

export function observeToolResultShape(result: Facts): Facts {
	return {
		keys: Object.keys(result), contentKind: Array.isArray(result.content) ? "blocks" : typeof result.content,
		contentFingerprint: fingerprint(JSON.stringify(result.content)), isError: result.is_error === true,
		emptyNoteMatches: result.content === EMPTY_NOTE, errorTextMatches: result.content === ERROR_TEXT,
		errorPrefixMatches: result.content === `Error: ${ERROR_TEXT}`,
	};
}

export default {
	name: "06-tool-result-shapes", mode: "live",
	inputs: { cases: ["text", "empty", "error"], model: "claude-haiku-5-5[1m]", driver: "real-MCP-before-and-after-production-rebuild" },
	expected: { contentAndSerializedKeyOrderPreserved: true },
	async run(context) {
		const cases: Facts[] = [];
		for (const kind of ["text", "empty", "error"]) {
			const observed = await withLiveRunner(context, async runner => {
				const tools = [{ name: "verify_shape", description: "Return a fixed fixture. Call exactly once and acknowledge even if empty or failed.", parameters: Type.Object({}) }];
				const messages: Message[] = [fixtureUser("Call verify_shape exactly once, then reply only READY, even if the result is empty or an error. Never repeat the call.")];
				const call = await runner.turn({ messages, tools });
				messages.push(call);
				const calls = call.content.filter(block => block.type === "toolCall");
				expect(calls.length === 1 && calls[0].name === "verify_shape", "shape-tool-call-mismatch");
				const content = kind === "empty" ? [] : kind === "error" ? [{ type: "text" as const, text: ERROR_TEXT }]
					: [{ type: "text" as const, text: "Fixture alpha" }, { type: "text" as const, text: "Fixture beta" }];
				messages.push({ role: "toolResult", toolCallId: calls[0].id, toolName: calls[0].name, content, isError: kind === "error", timestamp: 0 });
				const answer = await runner.turn({ messages, tools });
				expect(answer.stopReason !== "toolUse", "shape-tool-repeated");
				messages.push(answer);
				await runner.harness.waitForIdle();
				const native = resultFor(runner.payloadFor(runner.requests.at(-1)!), calls[0].id);
				runner.harness.runtime.markRebuildForSession(runner.workspace.sessionId, "verification-shape-rebuild");
				messages.push(fixtureUser("After rebuilding, reply only READY without calling any tools."));
				await runner.turn({ messages, tools });
				await runner.harness.waitForIdle();
				const rebuilt = resultFor(runner.payloadFor(runner.requests.at(-1)!), calls[0].id);
				return { kind, native: observeToolResultShape(native), rebuilt: observeToolResultShape(rebuilt), matches: JSON.stringify(native) === JSON.stringify(rebuilt) };
			});
			cases.push(observed);
		}
		expect(cases.every(result => result.matches), "tool-result-shape-drift", { cases });
		return { cases };
	},
} satisfies VerificationCheck;
