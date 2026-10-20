import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { fixtureUser } from "../harness.js";
import { withLiveRunner } from "../live.js";
import { fingerprint } from "../report.js";
import { expect, type VerificationCheck } from "../types.js";

export default {
	name: "05-prompt-refresh", mode: "live",
	inputs: { control: ["append-A", "append-A"], candidate: ["append-A", "append-A", "append-B"], model: "claude-haiku-5-5", reasoning: "omitted", cacheIsolation: "unique-append-marker-per-arm" },
	expected: { unchangedAppendCachePreservedAgainstControl: true, currentAppendOnResume: true, previousAppendAbsent: true },
	async run(context) {
		let isControl = true;
		return withLiveRunner(context, async runner => {
			const markerA = "BRIDGE_PROMPT_REFRESH_ALPHA";
			const markerB = "BRIDGE_PROMPT_REFRESH_BRAVO";
			const stable = Array.from({ length: 96 }, (_, i) => `Fixture rule ${i}: These inert verification notes require no action, tool, file, or external service.`).join("\n");
			async function sequence(markers: string[]) {
				const messages: Message[] = [];
				const sessionId = randomUUID();
				// Isolate each arm's appended prefix, so the candidate cannot reuse a
				// prefix the control warmed. Normalize its measured token-size difference.
				const armMarker = randomUUID();
				const observations = [];
				for (const [i, marker] of markers.entries()) {
					const append = `${armMarker}\n${marker}\n${stable}`;
					runner.harness.runtime.promptCaptures.record(append, { custom: append, contextFiles: [], skills: [] });
					messages.push(fixtureUser(`Verification turn ${i + 1}: reply with READY and nothing else. Do not call tools.`));
					const firstRequest = runner.requests.length;
					const result = await runner.turn({ systemPrompt: append, messages, tools: [] }, { sessionId });
					messages.push(result);
					await runner.harness.waitForIdle();
					const request = runner.requests.slice(firstRequest).at(-1);
					expect(request?.usage, "prompt-request-usage-not-captured");
					const system = JSON.stringify(runner.payloadFor(request).system);
					const options = runner.queryOptions().at(-1)!;
					observations.push({
						turn: i + 1, system: fingerprint(system), normalizedSystem: fingerprint(system.replaceAll(armMarker, "<ARM>")),
						hasAlpha: system.includes(markerA), hasBravo: system.includes(markerB),
						resume: options.resume ?? null,
						snapshot: typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.snapshot ?? "default" : null,
						usage: request.usage,
					});
				}
				return observations;
			}
			const control = await sequence([markerA, markerA]);
			isControl = false;
			const candidate = await sequence([markerA, markerA, markerB]);
			const controlCacheableInput = control[0].usage.cacheRead + control[0].usage.cacheWrite;
			const candidateCacheableInput = candidate[0].usage.cacheRead + candidate[0].usage.cacheWrite;
			const cacheComparison = {
				controlSecondCacheRead: control[1].usage.cacheRead,
				candidateSecondCacheRead: candidate[1].usage.cacheRead,
				delta: candidate[1].usage.cacheRead - control[1].usage.cacheRead,
				controlCacheableInput, candidateCacheableInput,
				normalizedDelta: (candidate[1].usage.cacheRead - candidateCacheableInput) - (control[1].usage.cacheRead - controlCacheableInput),
				controlPreviousInput: control[0].usage.input + control[0].usage.cacheRead + control[0].usage.cacheWrite,
				candidatePreviousInput: candidate[0].usage.input + candidate[0].usage.cacheRead + candidate[0].usage.cacheWrite,
				controlSystemStable: control[0].system.sha256 === control[1].system.sha256,
				candidateSystemStable: candidate[0].system.sha256 === candidate[1].system.sha256,
				matchedSystemExceptIsolationMarker: control[0].normalizedSystem.sha256 === candidate[0].normalizedSystem.sha256,
			};
			const currentAppendOnResume = candidate[2].hasBravo && !candidate[2].hasAlpha;
			const observed = {
				control, candidate, cacheComparison, currentAppendOnResume,
				absoluteCacheCriterionMet: candidate[1].usage.cacheRead >= cacheComparison.candidatePreviousInput,
				comparisonScope: "paired-runs-with-isolated-append-prefixes; normalize-only-measured-input-size-difference",
			};
			expect(control[0].resume === null && candidate[0].resume === null && control[1].resume &&
				candidate[1].resume && candidate[1].resume === candidate[2].resume && control[1].resume !== candidate[1].resume,
				"prompt-fixture-not-resumed-independently", observed);
			expect(control.every(turn => turn.snapshot === "default") && candidate.every(turn => turn.snapshot === false), "snapshot-option-not-applied", observed);
			expect(candidate[0].hasAlpha && candidate[1].hasAlpha && currentAppendOnResume, "resumed-prompt-stale", observed);
			expect(cacheComparison.controlSystemStable && cacheComparison.candidateSystemStable && cacheComparison.matchedSystemExceptIsolationMarker &&
				cacheComparison.controlSecondCacheRead > 0 && cacheComparison.normalizedDelta >= 0, "unchanged-append-cache-regressed", observed);
			return observed;
		}, 180000, options => {
			if (!isControl || !options.systemPrompt || typeof options.systemPrompt !== "object" || Array.isArray(options.systemPrompt)) return options;
			// Reproduce only the previous snapshot policy; every other production
			// option, workspace, prompt and model remains identical to the candidate.
			const { snapshot: _snapshot, ...systemPrompt } = options.systemPrompt;
			return { ...options, systemPrompt };
		});
	},
} satisfies VerificationCheck;
