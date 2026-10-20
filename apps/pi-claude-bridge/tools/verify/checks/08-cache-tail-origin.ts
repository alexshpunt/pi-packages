import { readFileSync } from "node:fs";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { openSession } from "cc-session-io";
import { compareRequestPrefix, messageShapes, systemTextAsBlocks } from "../fidelity.js";
import { fixtureUser } from "../harness.js";
import { withLiveRunner } from "../live.js";
import { latestRequest, restartedProcess, seedPrompt, usageComparison } from "../rebuild-cases.js";
import { expect, type CheckContext, type Facts, type VerificationCheck } from "../types.js";

// Where the cache shortfall after a resumed CC session comes from. Every condition is
// the first-to-second request transition of a fresh CC session with a unique seed, so
// runs cannot warm each other's cache. The "system-text-blocks" arm is a diagnostic
// intervention at the capture proxy, never production behavior: it re-sends string
// system-role messages as one text block, to test whether that shape change alone
// accounts for the shortfall.

const IN_PROCESS_CONDITIONS = ["native-resume", "forced-rebuild", "pi-only-turn"] as const;
type InProcessCondition = typeof IN_PROCESS_CONDITIONS[number];
type Condition = InProcessCondition | "process-restart";
type Arm = "observed" | "system-text-blocks";
const TARGET_CONDITIONS: Condition[] = ["process-restart", "pi-only-turn"];
const REPETITIONS = 2;

const describeShape = (shape: Facts) => `${shape.role}:${shape.kind}:${(shape.blocks as Facts[])
	.map(block => `${block.type}${block.textBytes ?? ""}${block.hasCacheControl ? "*cc" : ""}`).join("|")}`;
const shapeKey = (shape: Facts) => JSON.stringify([shape.role, shape.kind, (shape.blocks as Facts[]).map(block => [block.type, block.textBytes])]);
const cachePoints = (shapes: Facts[]) => shapes.flatMap((shape, index) => (shape.blocks as Facts[]).some(block => block.hasCacheControl) ? [index] : []);

/** The first message present in both requests whose role, content kind or block sizes changed. */
function firstShapeChange(before: Facts[], after: Facts[]): Facts | null {
	const index = before.findIndex((shape, i) => !after[i] || shapeKey(shape) !== shapeKey(after[i]));
	if (index < 0) return null;
	return { index, role: before[index].role, before: describeShape(before[index]), after: after[index] ? describeShape(after[index]) : null };
}

function shapeFacts(before: Facts[], after: Facts[]): Facts {
	return {
		beforeShapes: before.map(describeShape), afterShapes: after.map(describeShape),
		beforeCachePoints: cachePoints(before), afterCachePoints: cachePoints(after),
		firstShapeChange: firstShapeChange(before, after),
	};
}

const usageFacts = (usage: Facts) => {
	const { before, after, shortfall, originalMetricShortfall, newInputTokens, cacheWriteAboveNewInput } = usage;
	return { before, after, shortfall, originalMetricShortfall, newInputTokens, cacheWriteAboveNewInput };
};

async function measureInProcess(context: CheckContext, condition: InProcessCondition, arm: Arm): Promise<Facts> {
	return withLiveRunner(context, async runner => {
		const messages: Message[] = [fixtureUser(seedPrompt("Reply only READY. Do not call tools."))];
		messages.push(await runner.turn({ messages, tools: [] }));
		await runner.harness.waitForIdle();
		const initial = runner.harness.runtime.sessionStateFor(runner.workspace.sessionId);
		expect(initial, "seed-mirror-missing");
		const before = await latestRequest(runner);
		const jsonlPath = openSession({ sessionId: initial.sessionId, projectPath: runner.workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR }).jsonlPath;
		const seedFile = readFileSync(jsonlPath);
		const seedEndedMs = Date.now();
		if (condition === "forced-rebuild") runner.harness.runtime.markRebuildForSession(runner.workspace.sessionId, "verification-forced-rebuild");
		if (condition === "pi-only-turn") {
			messages.push(fixtureUser("An offline provider fixture supplies the next answer."));
			messages.push({ ...messages[1] as AssistantMessage, content: [{ type: "text", text: "Offline fixture answer." }], provider: "verification-other-provider",
				model: "fixture-model", api: "verification-fixture", stopReason: "stop", timestamp: 0 });
		}
		messages.push(fixtureUser("Next turn: reply only READY without tools."));
		const gapBeforeNextTurnMs = Date.now() - seedEndedMs;
		await runner.turn({ messages, tools: [] });
		await runner.harness.waitForIdle();
		const after = await latestRequest(runner);
		const current = runner.harness.runtime.sessionStateFor(runner.workspace.sessionId);
		expect(current && runner.queryOptions().at(-1)?.resume === current.sessionId, "transition-not-resumed");
		const nextFile = readFileSync(jsonlPath);
		return {
			condition, arm, ...usageFacts(usageComparison(before, after)),
			...shapeFacts(messageShapes(runner.payloadFor(before)), messageShapes(runner.payloadFor(after))),
			fidelity: compareRequestPrefix(runner.payloadFor(before), runner.payloadFor(after)).firstDifference,
			shapeFidelity: compareRequestPrefix(runner.payloadFor(before), runner.payloadFor(after), false).firstDifference,
			sameCcSession: current.sessionId === initial.sessionId,
			seedFilePrefixPreserved: nextFile.subarray(0, seedFile.length).equals(seedFile),
			gapBeforeNextTurnMs,
		};
	}, 180000, undefined, undefined, arm === "system-text-blocks" ? systemTextAsBlocks : undefined);
}

async function measureRestart(context: CheckContext, arm: Arm): Promise<Facts> {
	const measured = await restartedProcess(context, arm === "system-text-blocks" ? arm : undefined);
	const shapes = measured.requestShapes as { before: Facts[]; after: Facts[] };
	const processes = measured.processes as Facts[];
	return {
		condition: "process-restart", arm, ...usageFacts(measured),
		...shapeFacts(shapes.before, shapes.after),
		fidelity: (measured.fidelity as Facts).firstDifference, shapeFidelity: (measured.shapeFidelity as Facts).firstDifference,
		sameCcSession: measured.previousSessionId === measured.currentSessionId,
		previousSessionUnchanged: measured.previousSessionUnchanged,
		branchLinks: processes.map(process => [process.startingBranchLinkCount, process.finishingBranchLinkCount]),
		linkInModelContext: processes.some(process => process.modelContextContainsLinkEntry !== false),
	};
}

const isTargetMet = (row: Facts) => row.shortfall === 0 && row.cacheWriteAboveNewInput === 0;

export default {
	name: "08-cache-tail-origin", mode: "live", group: "cache",
	inputs: {
		model: "claude-haiku-5-5[1m]", repetitions: REPETITIONS, transition: "first-to-second request of a fresh CC session, unique seed per run",
		conditions: [...IN_PROCESS_CONDITIONS, "process-restart"], arms: ["observed", "system-text-blocks"],
		intervention: "capture proxy re-sends string system-role messages as one text block (diagnostic only)",
		order: "repetition 1 as listed, repetition 2 reversed",
	},
	expected: { targets: TARGET_CONDITIONS, observedShortfallTokens: 0, cacheWriteAboveNewInput: 0 },
	async run(context) {
		const plan: [Condition, Arm][] = [...IN_PROCESS_CONDITIONS, "process-restart" as const]
			.flatMap(condition => [[condition, "observed"], [condition, "system-text-blocks"]] as [Condition, Arm][]);
		const rows: Facts[] = [];
		for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
			const order = repetition === 1 ? plan : [...plan].reverse();
			for (const [position, [condition, arm]] of order.entries()) {
				const beforeCalls = context.apiCalls;
				const row = condition === "process-restart" ? await measureRestart(context, arm) : await measureInProcess(context, condition, arm);
				rows.push({ repetition, position, ...row, apiCalls: context.apiCalls - beforeCalls });
			}
		}
		const series = (condition: Condition, arm: Arm) => rows.filter(row => row.condition === condition && row.arm === arm);
		const summary = [...IN_PROCESS_CONDITIONS, "process-restart" as const].map(condition => ({
			condition,
			observedShortfall: series(condition, "observed").map(row => row.shortfall),
			interventionShortfall: series(condition, "system-text-blocks").map(row => row.shortfall),
			observedCacheWriteAboveNewInput: series(condition, "observed").map(row => row.cacheWriteAboveNewInput),
			interventionCacheWriteAboveNewInput: series(condition, "system-text-blocks").map(row => row.cacheWriteAboveNewInput),
			observedFirstShapeChange: series(condition, "observed").map(row => row.firstShapeChange),
		}));
		const native = series("native-resume", "observed").map(row => Number(row.shortfall));
		const bridgeAddedShortfall = (["forced-rebuild", "pi-only-turn", "process-restart"] as Condition[]).map(condition => ({
			condition, minusNativeResume: series(condition, "observed").map((row, index) => Number(row.shortfall) - (native[index] ?? NaN)),
		}));
		const targetsMet = TARGET_CONDITIONS.every(condition => {
			const observed = series(condition, "observed");
			return observed.length === REPETITIONS && observed.every(isTargetMet);
		});
		const observed = { rows, summary, bridgeAddedShortfall, targetsMet };
		expect(targetsMet, "cache-tail-target-not-met", observed);
		return observed;
	},
} satisfies VerificationCheck;
