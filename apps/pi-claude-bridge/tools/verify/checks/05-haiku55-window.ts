import { fixtureUser } from "../harness.js";
import { withLiveRunner } from "../live.js";
import { expect, type VerificationCheck } from "../types.js";

export default {
	name: "05-haiku55-window", mode: "live",
	inputs: { model: "claude-haiku-5-5", reasoning: "off" },
	expected: { contextWindow: 1000000, nativeModel: "claude-haiku-5-5[1m]", pickerHasOneM: true },
	async run(context) {
		return withLiveRunner(context, async runner => {
			await runner.turn({ messages: [fixtureUser("Reply with READY, without tools.")], tools: [] });
			await runner.harness.waitForIdle();
			const usages = runner.sdkResults.flatMap(result => result.modelUsage as { model: string; contextWindow: number }[]);
			const observed = {
				registeredContextWindow: runner.harness.model.contextWindow,
				nativeModel: runner.harness.cliModel, pickerHasOneM: /\b1M\b/.test(runner.harness.model.name),
				servedContextWindows: usages.map(usage => usage.contextWindow),
			};
			expect(observed.registeredContextWindow === 1000000 && observed.nativeModel === "claude-haiku-5-5[1m]" &&
				observed.pickerHasOneM && usages.length > 0 && usages.every(usage => usage.contextWindow === 1000000),
				"haiku-window-mismatch", observed);
			return observed;
		});
	},
} satisfies VerificationCheck;
