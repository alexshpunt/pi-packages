import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { measureRebuildScenario, REBUILD_SCENARIOS } from "../rebuild-cases.js";
import { expect, VerificationError, type Facts, type VerificationCheck } from "../types.js";

export default {
	name: "06-rebuild-cache", mode: "live", group: "cache",
	inputs: { model: "claude-haiku-5-5[1m]", scenarios: [...REBUILD_SCENARIOS], repetitions: 2, largeResultBytes: 90 * 1024,
		faults: "controlled SDK error-result/exception after real responses; exception only after native process exit", restart: "two real Pi processes, same persisted Pi session" },
	expected: { shortfallTokens: 0, faithfulRequestPrefix: true, baselineAndCurrentPaired: true },
	async run(context) {
		const baselinePath = join(context.appDir, "../../docs/verification/claude-bridge/06-rebuild-cache-before.json");
		const baselineReport = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : undefined;
		const baseline: Facts[] = baselineReport?.checks?.find((check: Facts) => check.name === "06-rebuild-cache")?.observed?.measurements ?? [];
		const measurements: Facts[] = [];
		for (const scenario of REBUILD_SCENARIOS) {
			for (let repetition = 1; repetition <= 2; repetition++) {
				const beforeCalls = context.apiCalls;
				let observed: Facts;
				try { observed = await measureRebuildScenario(context, scenario); }
				catch (error) {
					if (error instanceof VerificationError) Object.assign(error.observed, { measurements, failedScenario: scenario, failedRepetition: repetition });
					throw error;
				}
				const original = baseline.find(row => row.scenario === scenario && row.repetition === repetition);
				measurements.push({ scenario, repetition, ...observed, apiCalls: context.apiCalls - beforeCalls,
					baseline: original ? { before: original.before, after: original.after, shortfall: original.diagnosticShortfall,
						originalMetricShortfall: original.originalMetricShortfall ?? original.shortfall } : null });
			}
		}
		const repeatDifferences = REBUILD_SCENARIOS.map(scenario => {
			const rows = measurements.filter(row => row.scenario === scenario);
			return { scenario, shortfallDifference: Math.abs(Number(rows[0].shortfall) - Number(rows[1].shortfall)) };
		});
		const observed = { metric: "max(0, previous(cacheRead + cacheWrite) - current.cacheRead)",
			originalMetric: "max(0, previous(input + cacheRead + cacheWrite) - current.cacheRead)",
			diagnosticMetric: "max(0, previous(cacheRead + cacheWrite) - current.cacheRead)",
			comparisonNormalizations: ["billing-header", "cache_control", "single-plain-text-block"],
			baselineAvailable: baseline.length > 0, measurements, repeatDifferences };
		expect(measurements.every(row => row.shortfall === 0 && (row.fidelity as Facts).firstDifference === null), "rebuild-cache-target-not-met", observed);
		return observed;
	},
} satisfies VerificationCheck;
