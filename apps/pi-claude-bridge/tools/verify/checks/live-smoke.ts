import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fixtureUser } from "../harness.js";
import { withLiveRunner } from "../live.js";
import { fingerprint } from "../report.js";
import { expect, type VerificationCheck } from "../types.js";

const textOf = (message: AssistantMessage) => message.content.filter(block => block.type === "text").map(block => block.text).join("");

export default {
	name: "live-smoke", mode: "live",
	inputs: { model: "claude-haiku-5-5", driver: "shared-provider-runtime", reasoning: "off", reasoningOption: "omitted", tool: "verify_echo" },
	expected: { plainTurn: true, toolCalls: 1, returnedValueInFinalAnswer: true, apiKeySource: "none" },
	async run(context) {
		return withLiveRunner(context, async runner => {
			const marker = `verification-${randomUUID()}`;
			const tools = [{ name: "verify_echo", description: "Return the supplied verification value unchanged.", parameters: Type.Object({ value: Type.String() }) }];
			const messages: Message[] = [fixtureUser("Reply with READY. Do not call any tools for this message.")];
			const turns: AssistantMessage[] = [];
			// Pi represents off by omitting SimpleStreamOptions.reasoning.
			const plain = await runner.turn({ messages, tools });
			expect(plain.stopReason !== "toolUse" && /\bREADY\b/.test(textOf(plain)), "plain-turn-answer-missing");
			turns.push(plain);
			messages.push(plain);
			await runner.harness.waitForIdle();
			messages.push(fixtureUser(`Call verify_echo exactly once with value "${marker}". Then reply with the value returned by that tool. Do not call any other tools.`));
			const calls = [];
			let final: AssistantMessage | undefined;
			for (let step = 0; step < 3; step++) {
				const result = await runner.turn({ messages, tools });
				turns.push(result);
				messages.push(result);
				const toolCalls = result.content.filter(block => block.type === "toolCall");
				if (!toolCalls.length) { final = result; break; }
				for (const call of toolCalls) {
					expect(call.name === "verify_echo" && call.arguments.value === marker && calls.length === 0, "unexpected-tool-call");
					// This is the Pi-side executor. The actual bridge MCP handler receives this result.
					const value = call.arguments.value as string;
					calls.push({ name: call.name, argumentsFingerprint: fingerprint(JSON.stringify(call.arguments)), resultFingerprint: fingerprint(value) });
					messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: value }], isError: false, timestamp: Date.now() });
				}
			}
			expect(calls.length === 1 && final && textOf(final).includes(marker), "tool-result-not-in-final-answer");
			await runner.harness.waitForIdle();
			expect(runner.requests.length >= 3, "model-requests-not-observed");
			const usage = Object.fromEntries((["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const).map(key => [key, turns.reduce((sum, turn) => sum + turn.usage[key], 0)]));
			expect(usage.totalTokens > 0, "model-usage-missing");
			return { plainAnswer: fingerprint(textOf(plain)), finalAnswer: fingerprint(textOf(final)), returnedValueInFinalAnswer: true, toolCalls: calls, usage };
		});
	},
} satisfies VerificationCheck;
