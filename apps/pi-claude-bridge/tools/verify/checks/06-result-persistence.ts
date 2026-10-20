import { measureRebuildScenario } from "../rebuild-cases.js";
import { expect, type Facts, type VerificationCheck } from "../types.js";

export default {
	name: "06-result-persistence", mode: "live",
	inputs: { scenarios: ["image-result", "large-result"], largeResultBytes: 90 * 1024 },
	expected: { shortfallTokens: 0, faithfulRequestPrefix: true, referencedFilesUnchanged: true },
	async run(context) {
		const measurements: Facts[] = [];
		for (const scenario of ["image-result", "large-result"] as const) {
			const measurement = await measureRebuildScenario(context, scenario);
			measurements.push({ scenario, ...measurement });
			const before = (measurement.beforeShapes as Facts).storedResults as Facts;
			const after = (measurement.afterShapes as Facts).storedResults as Facts;
			const originalFiles = before.referencedFiles as Facts[];
			const currentFiles = after.referencedFiles as Facts[];
			expect(originalFiles.length > 0 && originalFiles.every(file => currentFiles.some(current =>
				current.pathSha256 === file.pathSha256 && current.sha256 === file.sha256 && current.byteLength === file.byteLength)),
				"referenced-result-files-changed", { measurements });
			if (scenario === "large-result") expect(Number(after.verifiedFixtureFiles) > 0, "saved-result-no-longer-matches-pi", { measurements });
		}
		expect(measurements.every(row => row.shortfall === 0 && (row.fidelity as Facts).firstDifference === null),
			"saved-result-cache-target-not-met", { measurements });
		return { measurements };
	},
} satisfies VerificationCheck;
