import type { Model } from "@earendil-works/pi-ai";
import { withCapturedQueries } from "../capture.js";
import { fixtureUser } from "../harness.js";
import { captureSpawn, flagValues } from "../spawn.js";
import { expect, type VerificationCheck } from "../types.js";

export default {
	name: "05-thinking-nonadaptive", mode: "spawn",
	inputs: { models: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"], reasoning: ["high", "off"] },
	expected: { legacyOptionsUnchanged: true, offDeliveredToArgv: true, modelRequests: 0 },
	async run(context) {
		return withCapturedQueries(context, async (harness, captures, workspace) => {
			const observations = [];
			for (const id of ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"]) {
				const catalog = harness.runtime.MODELS.find(model => model.id === id);
				expect(catalog, "legacy-model-not-in-catalog");
				const model = { ...harness.model, ...catalog } as Model<any>;
				for (const reasoning of ["high", undefined] as const) {
					for (const path of ["provider", "summary"]) {
						const input = { messages: [fixtureUser("Legacy option fixture.")], tools: [] };
						const options = { sessionId: workspace.sessionId, reasoning };
						const result = await (path === "provider"
							? harness.runtime.streamClaudeAgentSdk(model, input, options)
							: harness.runtime.isolatedStreamFn(model, input, { ...options, cacheRetention: "none" })).result();
						expect(result.stopReason !== "error", "legacy-fixture-turn-failed");
						await harness.waitForIdle();
						const captured = captures.at(-1)!.options;
						const spawned = await captureSpawn(captured, workspace);
						const observation = {
							model: id, path, reasoning: reasoning ?? "off", effort: captured.effort ?? null,
							thinking: captured.thinking ?? null, extraDisplay: captured.extraArgs?.["thinking-display"] ?? null,
							thinkingArguments: flagValues(spawned.argv, "thinking"),
							displayArguments: flagValues(spawned.argv, "thinking-display"),
						};
						observations.push(observation);
						expect(reasoning === "high"
							? observation.effort === "high" && observation.thinking === null &&
								observation.extraDisplay === (path === "provider" ? "summarized" : null) &&
								observation.thinkingArguments.length === 0
							: observation.effort === null && observation.thinking?.type === "disabled" &&
								JSON.stringify(observation.thinkingArguments) === JSON.stringify(["disabled"]) &&
								observation.displayArguments.length === 0,
							"legacy-thinking-contract-changed", { cases: observations });
					}
				}
			}
			return {
				cases: observations, modelRequests: 0,
				classificationEvidence: {
					kind: "shipped-artifact-static-mechanism", claudeCode: "2.1.303", function: "MMo",
					artifactSha256: "d2da3b003dc08b88b7230469014fe3e1dc6fe94bc8f648e89b34175d30269370",
					functionFileOffset: 215286755, liveLegacyModelsChecked: false,
				},
			};
		});
	},
} satisfies VerificationCheck;
