import { withCapturedQueries, observeOptions } from "../capture.js";
import { fixtureUser } from "../harness.js";
import { fingerprint } from "../report.js";
import { expect, type VerificationCheck } from "../types.js";

export default {
	name: "summary-options", mode: "offline",
	inputs: { model: "claude-haiku-5-5", reasoning: "high", cacheRetention: "none" },
	expected: { queryCount: 1, isolated: true, maxTurns: 1, fixtureCwd: true },
	async run(context) {
		return withCapturedQueries(context, async (harness, captures, workspace) => {
			const result = await harness.runtime.isolatedStreamFn(harness.model, {
				systemPrompt: "Summarize this verification fixture.",
				messages: [fixtureUser("A fixed summary fixture.")], tools: [],
			}, { sessionId: workspace.sessionId, cacheRetention: "none", reasoning: "high" }).result();
			expect(result.stopReason !== "error", "summary-query-failed");
			expect(captures.length === 1, "unexpected-summary-query-count");
			const captured = captures[0];
			expect(captured.options.cwd === workspace.cwd, "summary-cwd-mismatch");
			expect(captured.options.model === harness.cliModel, "summary-model-mismatch");
			expect(!captured.options.resume && !captured.options.mcpServers && captured.options.persistSession === false && captured.options.maxTurns === 1, "summary-not-isolated");
			return { options: observeOptions(captured.options), input: fingerprint(JSON.stringify(captured.content)), isolated: true };
		});
	},
} satisfies VerificationCheck;
