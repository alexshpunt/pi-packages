import { measureRebuildScenario } from "../rebuild-cases.js";
import { expect, type Facts, type VerificationCheck } from "../types.js";

export default {
	name: "06-restart-continuity", mode: "live",
	// The cache shortfall stays in the observation; the optional cache group judges it.
	inputs: { processes: 2, samePersistedPiSession: true, cacheShortfall: "recorded, judged by the cache group" },
	expected: { newCCSession: true, sourceUnchanged: true, currentBranchLinkRestored: true, linkExcludedFromModel: true, contentPreserved: true },
	async run(context) {
		const measurement = await measureRebuildScenario(context, "process-restart");
		const processes = measurement.processes as Facts[];
		expect(processes[0].startingBranchLinkCount === 0 && processes[0].finishingBranchLinkCount === 1 &&
			processes[1].startingBranchLinkCount === 1 && processes[1].finishingBranchLinkCount === 2 &&
			processes.every(process => process.processExited === true && process.modelContextContainsLinkEntry === false),
			"restart-branch-link-contract-failed", { measurement });
		expect(measurement.previousSessionUnchanged === true && measurement.previousSessionId !== measurement.currentSessionId,
			"restart-source-overwritten", { measurement });
		expect((measurement.fidelity as Facts).firstDifference === null, "restart-content-not-preserved", { measurement });
		return { measurement };
	},
} satisfies VerificationCheck;
