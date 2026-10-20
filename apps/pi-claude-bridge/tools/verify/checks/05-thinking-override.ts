import { randomUUID } from "node:crypto";
import { fixtureUser } from "../harness.js";
import { withLiveRunner } from "../live.js";
import { expect, type Facts, type VerificationCheck } from "../types.js";

export default {
	name: "05-thinking-override", mode: "live",
	inputs: { model: "claude-haiku-5-5", cases: ["settings-false-high", "env-zero-high", "settings-true-off"] },
	expected: { highThinkingBlocks: true, explicitAdaptive: true, alwaysThinkingExceptionPreserved: true },
	async run(context) {
		let caseName = "settings-false-high";
		return withLiveRunner(context, async runner => {
			const observations: Facts[] = [];
			for (const name of ["settings-false-high", "env-zero-high", "settings-true-off"]) {
				caseName = name;
				// No prior answer in any case: repeated questions in a resumed session
				// can legitimately produce no thinking even when it is enabled.
				const messages = [fixtureUser("Compute 98765 multiplied by 43217 carefully, without tools. Reply with only the integer.")];
				const firstRequest = runner.requests.length;
				const result = await runner.turn({ messages, tools: [] }, {
					sessionId: randomUUID(), ...(name.endsWith("-off") ? {} : { reasoning: "high" as const }),
				});
				await runner.harness.waitForIdle();
				const options = runner.queryOptions().at(-1)!;
				const request = runner.requests.slice(firstRequest).at(-1);
				const body = request ? runner.payloadFor(request) : {};
				const thinking = body.thinking as { type?: string; display?: string } | undefined;
				observations.push({
					case: name, thinkingBlocks: result.content.filter(block => block.type === "thinking").length,
					resume: options.resume ?? null, modelOffUnsupported: runner.harness.model.thinkingLevelMap?.off === null,
					alwaysThinkingEnabled: typeof options.settings === "object" ? options.settings.alwaysThinkingEnabled : null,
					maxThinkingTokens: options.env?.MAX_THINKING_TOKENS ?? null,
					thinking: options.thinking ?? null, effort: options.effort ?? null,
					requestThinkingType: thinking?.type ?? "absent", requestDisplay: thinking?.display ?? null,
					hasExtraDisplay: Object.hasOwn(options.extraArgs ?? {}, "thinking-display"),
				});
			}
			const high = observations.slice(0, 2);
			const off = observations[2];
			const offLiveDisabledCheck = off.modelOffUnsupported ? "not_applicable-always-thinking-model" : "checked";
			const observed = { cases: observations, offLiveDisabledCheck };
			expect(high.every(item => Number(item.thinkingBlocks) > 0 && item.requestThinkingType === "adaptive" && item.requestDisplay === "summarized"),
				"thinking-selection-not-applied", observed);
			expect(high.every(item => (item.thinking as { type?: string })?.type === "adaptive" && !item.hasExtraDisplay),
				"thinking-not-typed", observed);
			expect(off.modelOffUnsupported ? off.thinking === null : off.thinkingBlocks === 0,
				"thinking-off-contract-changed", observed);
			return observed;
		}, 180000, options => {
			const env = { ...options.env };
			if (caseName === "env-zero-high") env.MAX_THINKING_TOKENS = "0";
			else delete env.MAX_THINKING_TOKENS;
			return { ...options, env, settings: {
				...(typeof options.settings === "object" ? options.settings : {}),
				alwaysThinkingEnabled: caseName !== "settings-false-high",
			} };
		});
	},
} satisfies VerificationCheck;
