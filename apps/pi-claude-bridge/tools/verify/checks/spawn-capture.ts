import { buildProviderQueryOptions, buildSummaryQueryOptions } from "../../../src/adapters/claude/query-options.js";
import { createHarness } from "../harness.js";
import { captureSpawn, flagValues } from "../spawn.js";
import { expect, type VerificationCheck } from "../types.js";
import { withWorkspace } from "../workspace.js";

export default {
	name: "spawn-capture", mode: "spawn",
	inputs: { cases: ["provider", "summary"], model: "claude-haiku-5-5", executable: "network-free-node-wrapper" },
	expected: { modelArgumentCount: 1, entrypointRecorded: true, apiCalls: 0 },
	async run(context) {
		return withWorkspace(false, async workspace => {
			const harness = createHarness(workspace, context.modelId);
			try {
				const observed = [];
				for (const [kind, build] of [["provider", buildProviderQueryOptions], ["summary", buildSummaryQueryOptions]] as const) {
					const options = build({ cwd: workspace.cwd, model: harness.model, cliModel: harness.cliModel, reasoning: "high", systemPrompt: "Spawn verification fixture." });
					const capture = await captureSpawn(options, workspace);
					const models = flagValues(capture.argv, "model");
					expect(models.length === 1 && models[0] === harness.cliModel, "spawn-model-argument-mismatch");
					expect(capture.env.CLAUDE_CODE_ENTRYPOINT === "sdk-ts", "sdk-entrypoint-not-applied");
					observed.push({ kind, modelArguments: models, env: capture.env, flags: Object.fromEntries(["thinking", "thinking-display", "effort", "strict-mcp-config"].map(name => [name, flagValues(capture.argv, name)])) });
				}
				return { captures: observed, networkFreeWrapper: true };
			} finally { await harness.close(); }
		});
	},
} satisfies VerificationCheck;
