import { withCapturedQueries, observeOptions } from "../capture.js";
import { fixtureUser } from "../harness.js";
import { captureSpawn, flagValues } from "../spawn.js";
import { expect, type VerificationCheck } from "../types.js";

export default {
	name: "05-model-typed", mode: "spawn",
	inputs: { paths: ["provider", "summary"], reasoning: "high" },
	expected: { typedModel: true, extraModel: false, modelArgumentCount: 1 },
	async run(context) {
		return withCapturedQueries(context, async (harness, captures, workspace) => {
			await harness.turn({ messages: [fixtureUser("Model option fixture.")], tools: [] }, { reasoning: "high" });
			await harness.waitForIdle();
			await harness.runtime.isolatedStreamFn(harness.model, {
				systemPrompt: "Summary fixture.", messages: [fixtureUser("Summarize briefly.")], tools: [],
			}, { sessionId: workspace.sessionId, cacheRetention: "none", reasoning: "high" }).result();
			expect(captures.length === 2, "model-query-count");
			const observations = [];
			for (const [i, capture] of captures.entries()) {
				const spawned = await captureSpawn(capture.options, workspace);
				observations.push({
					path: i === 0 ? "provider" : "summary", options: observeOptions(capture.options),
					typedModel: capture.options.model ?? null, hasExtraModel: Object.hasOwn(capture.options.extraArgs ?? {}, "model"),
					modelArguments: flagValues(spawned.argv, "model"),
					thinkingArguments: flagValues(spawned.argv, "thinking"),
					displayArguments: flagValues(spawned.argv, "thinking-display"),
				});
			}
			expect(observations.every(item => item.typedModel === harness.cliModel && !item.hasExtraModel &&
				item.modelArguments.length === 1 && item.modelArguments[0] === harness.cliModel), "model-not-typed-once", { queries: observations });
			return { queries: observations };
		});
	},
} satisfies VerificationCheck;
