import { withCapturedQueries, observeOptions } from "../capture.js";
import { fixtureUser } from "../harness.js";
import { fingerprint } from "../report.js";
import { expect, type VerificationCheck } from "../types.js";

export default {
	name: "provider-options", mode: "offline",
	inputs: { cases: ["first-turn", "resume-turn"], model: "claude-haiku-5-5" },
	expected: { queryCount: 2, singleModelOption: true, resumeUsesPreviousSession: true, fixtureCwd: true },
	async run(context) {
		return withCapturedQueries(context, async (harness, captures, workspace) => {
			const first = fixtureUser("First verification fixture.");
			const answer = await harness.turn({ messages: [first], tools: [] });
			expect(answer.stopReason !== "error", "first-turn-failed");
			await harness.waitForIdle();
			const resumed = await harness.turn({ messages: [first, answer, fixtureUser("Next verification fixture.")], tools: [] });
			expect(resumed.stopReason !== "error", "resume-turn-failed");
			await harness.waitForIdle();
			expect(captures.length === 2, "unexpected-query-count");
			expect(captures[0].options.resume === undefined && captures[1].options.resume === captures[0].sessionId, "resume-session-mismatch");
			for (const { options } of captures) {
				expect(options.cwd === workspace.cwd, "provider-cwd-mismatch");
				expect((options.model ?? options.extraArgs?.model) === harness.cliModel, "provider-model-mismatch");
				expect(Boolean(options.model) !== Object.hasOwn(options.extraArgs ?? {}, "model"), "duplicate-model-option");
			}
			return { queries: captures.map(capture => ({ options: observeOptions(capture.options), input: fingerprint(JSON.stringify(capture.content)) })), resumeUsesPreviousSession: true };
		});
	},
} satisfies VerificationCheck;
