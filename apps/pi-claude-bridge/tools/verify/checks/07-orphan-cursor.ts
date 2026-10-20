import type { Message } from "@earendil-works/pi-ai";
import { fixtureUser } from "../harness.js";
import { gate, init, parkSessionA, success, toolResult, toolUse, withTwoSessions } from "../reentrancy-cases.js";
import { expect, type VerificationCheck } from "../types.js";

export default {
	name: "07-orphan-cursor", mode: "offline",
	inputs: { driver: "production-runtime-scripted-query", parked: "session-A-at-tool-call", orphan: "session-B-result-after-abort" },
	expected: { orphanStopReason: "stop", cursorAfterOrphan: "orphan-history-length", queriesStarted: 0, parkedSessionUnchanged: true },
	async run(context) {
		return withTwoSessions(context, async sessions => {
			const { harness, scripts, calls, sessionA: sessionAId, sessionB, turn, waitForSession, activeCountFor } = sessions;
			const mirrorB = () => harness.runtime.sessionStateFor(sessionB);
			const sessionA = await parkSessionA(sessions);

			const first = fixtureUser("Session B first fixture.");
			scripts.push({ label: "B turn 1", steps: [init("cc-session-b"), success("Session B first answer.")] });
			const firstAnswer = await turn(sessionB, [first]);
			await waitForSession(sessionB);

			// B's next turn stops at a tool call and the user aborts it there.
			const abort = new AbortController();
			const toolCallId = "toolu_session_b";
			scripts.push({ label: "B aborted", steps: [init("cc-session-b-aborted"), ...toolUse(toolCallId), gate().wait, success("Session B unreachable answer.")] });
			const history: Message[] = [first, firstAnswer, fixtureUser("Session B second fixture.")];
			const parked = await turn(sessionB, history, abort.signal);
			expect(parked.stopReason === "toolUse", "session-b-not-parked", { stopReason: parked.stopReason });
			history.push(parked);
			abort.abort();
			await waitForSession(sessionB);

			// pi then hands back the aborted tool's result with the run's aborted signal.
			const cursorBeforeOrphan = mirrorB()?.cursor ?? null;
			const queriesBefore = calls.length;
			const orphanHistory = [...history, toolResult(toolCallId)];
			const orphan = await turn(sessionB, orphanHistory, abort.signal);
			const observed = {
				orphanStopReason: orphan.stopReason, orphanBlockCount: orphan.content.length,
				cursorBeforeOrphan, cursorAfterOrphan: mirrorB()?.cursor ?? null, orphanHistoryLength: orphanHistory.length,
				mirrorKeepsOwnSession: mirrorB()?.sessionId === "cc-session-b",
				queriesStarted: calls.length - queriesBefore,
				otherSessionInFlight: activeCountFor(sessionAId) === 1,
			};
			const parkedA = await sessionA.finish();
			Object.assign(observed, { parkedA });
			expect(observed.orphanStopReason === "stop" && observed.orphanBlockCount === 0 && observed.queriesStarted === 0,
				"orphan-result-not-ended", observed);
			expect(observed.otherSessionInFlight, "fixture-other-session-idle", observed);
			expect(observed.cursorAfterOrphan === orphanHistory.length && observed.mirrorKeepsOwnSession, "orphan-cursor-not-advanced", observed);
			expect(parkedA.isParkedQueryUnchanged && parkedA.completedStopReason === "stop" && parkedA.finalSessionId === "own",
				"parked-session-disturbed", observed);
			return observed;
		});
	},
} satisfies VerificationCheck;
