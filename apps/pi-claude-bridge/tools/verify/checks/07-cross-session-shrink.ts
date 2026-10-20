import { existsSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { getSessionPath } from "cc-session-io";
import { fixtureUser } from "../harness.js";
import { assistantText, gate, init, parkSessionA, success, toolResult, toolUse, withTwoSessions } from "../reentrancy-cases.js";
import { expect, type VerificationCheck } from "../types.js";

export default {
	name: "07-cross-session-shrink", mode: "offline",
	inputs: {
		driver: "production-runtime-scripted-query", parked: "session-A-at-tool-call",
		cursorBeforeShrink: 4, priorsAfterShrink: 2, control: "same-session-reentrant-user-call",
	},
	expected: {
		shrinkPath: "rebuild", shrinkResumesOwnSession: true, rebuiltFileExists: true,
		reentrantPath: "clean-start preserve-shared", reentrantResumes: false, parkedSessionUnchanged: true,
	},
	async run(context) {
		return withTwoSessions(context, async sessions => {
			const { harness, scripts, calls, syncPaths, sessionB, turn, waitForSession, workspace } = sessions;
			const mirrorB = () => harness.runtime.sessionStateFor(sessionB);
			const sessionA = await parkSessionA(sessions);

			// Session B completes two turns while A sits at its tool call.
			const setup = fixtureUser("Session B setup fixture."), first = fixtureUser("Session B first fixture.");
			scripts.push({ label: "B turn 1", steps: [init("cc-session-b"), success("Session B first answer.")] });
			const firstAnswer = await turn(sessionB, [setup, first]);
			await waitForSession(sessionB);
			scripts.push({ label: "B turn 2", steps: [init("cc-session-b-next"), success("Session B second answer.")] });
			await turn(sessionB, [setup, first, firstAnswer, fixtureUser("Session B second fixture.")]);
			await waitForSession(sessionB);
			const cursorBeforeShrink = mirrorB()?.cursor ?? null;

			// An extension folds B's history without any pi event: two priors replace four.
			const folded: Message[] = [fixtureUser("Summary of the earlier session B conversation."), assistantText("Acknowledged the session B summary.")];
			const afterFold = fixtureUser("Session B after-fold fixture.");
			const shrinkIndex = syncPaths.length;
			scripts.push({ label: "B after fold", steps: [init("cc-session-b-folded"), success("Session B folded answer.")] });
			const foldedAnswer = await turn(sessionB, [...folded, afterFold]);
			await waitForSession(sessionB);
			const shrink = {
				path: syncPaths[shrinkIndex] ?? null,
				isResumed: calls.at(-1)?.resume !== null,
				resumesOwnSession: calls.at(-1)?.resume === "cc-session-b",
				rebuiltFileExists: existsSync(getSessionPath("cc-session-b", workspace.cwd, process.env.CLAUDE_CONFIG_DIR)),
				mirrorKeepsOwnSession: mirrorB()?.sessionId === "cc-session-b",
				mirrorCursor: mirrorB()?.cursor ?? null,
			};

			// Control: a user-only call while B's own query is parked is real reentrancy.
			const history: Message[] = [...folded, afterFold, foldedAnswer, fixtureUser("Session B parked fixture.")];
			const resumeB = gate();
			scripts.push({ label: "B parked", steps: [init("cc-session-b-parked"), ...toolUse("toolu_session_b"), resumeB.wait, success("Session B parked answer.")] });
			const parked = await turn(sessionB, history);
			expect(parked.stopReason === "toolUse", "session-b-not-parked", { stopReason: parked.stopReason });
			history.push(parked);
			const mirrorBeforeReentry = { sessionId: mirrorB()?.sessionId, cursor: mirrorB()?.cursor };
			const reentrantIndex = syncPaths.length;
			scripts.push({ label: "B reentrant", steps: [init("cc-session-b-reentrant"), success("Session B reentrant answer.")] });
			await turn(sessionB, [fixtureUser("Session B reentrant fixture.")]);
			await waitForSession(sessionB, 1);
			const reentrant = {
				path: syncPaths[reentrantIndex] ?? null,
				isResumed: calls.at(-1)?.resume !== null,
				isMirrorUnchanged: mirrorB()?.sessionId === mirrorBeforeReentry.sessionId && mirrorB()?.cursor === mirrorBeforeReentry.cursor,
			};
			const delivery = turn(sessionB, [...history, toolResult("toolu_session_b")]);
			resumeB.open();
			const parkedCompletion = (await delivery).stopReason;
			await waitForSession(sessionB);

			const parkedA = await sessionA.finish();
			const observed = { cursorBeforeShrink, shrink, reentrant, parkedCompletion, parkedA, syncPaths: [...syncPaths] };
			expect(cursorBeforeShrink === 4, "fixture-cursor-mismatch", observed);
			expect(shrink.path === "rebuild" && shrink.resumesOwnSession && shrink.rebuiltFileExists && shrink.mirrorKeepsOwnSession,
				"cross-session-shrink-misclassified", observed);
			expect(reentrant.path === "clean-start preserve-shared" && !reentrant.isResumed && reentrant.isMirrorUnchanged && parkedCompletion === "stop",
				"same-session-reentry-not-detected", observed);
			expect(parkedA.isParkedQueryUnchanged && parkedA.completedStopReason === "stop" && parkedA.finalSessionId === "own",
				"parked-session-disturbed", observed);
			return observed;
		});
	},
} satisfies VerificationCheck;
