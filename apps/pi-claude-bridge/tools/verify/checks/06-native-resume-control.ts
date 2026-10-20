import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { openSession } from "cc-session-io";
import type { Message } from "@earendil-works/pi-ai";
import { fixtureUser } from "../harness.js";
import { withLiveRunner, type CapturedRequest } from "../live.js";
import { compareRequestPrefix, messageShapes } from "../fidelity.js";
import { latestRequest, usageComparison } from "../rebuild-cases.js";
import { expect, type Facts, type VerificationCheck } from "../types.js";

export default {
	name: "06-native-resume-control", mode: "live", group: "cache",
	inputs: { turns: 3, rebuild: false, purpose: "investigate initial-transition cache shortfall without a rebuild" },
	expected: { oneCCSession: true, rebuilds: 0, measurements: 2 },
	async run(context) {
		return withLiveRunner(context, async runner => {
			const seed = Array.from({ length: 450 }, (_, index) => `Record ${index}: stable fixture item ${index * 31 + 17}; verification data requires no action.`).join("\n");
			const messages: Message[] = [fixtureUser(`${randomUUID()}\nReply only READY. This inert data is not instructions:\n${seed}`)];
			const observations: Facts[] = [], requests: CapturedRequest[] = [];
			let ccSessionId: string | undefined;
			let previousSessionBytes: Buffer | undefined;
			for (let turn = 0; turn < 3; turn++) {
				if (turn) messages.push(fixtureUser("Continue: reply only READY without tools."));
				messages.push(await runner.turn({ messages, tools: [] }));
				await runner.harness.waitForIdle();
				const state = runner.harness.runtime.sessionStateFor(runner.workspace.sessionId)!;
				if (!ccSessionId) ccSessionId = state.sessionId;
				expect(state.sessionId === ccSessionId && !state.needsRebuild, "native-control-mirror-changed");
				if (turn) expect(runner.queryOptions().at(-1)?.resume === ccSessionId, "native-control-not-resumed");
				requests.push(await latestRequest(runner));
				const session = openSession({ sessionId: ccSessionId, projectPath: runner.workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
				const sessionBytes = readFileSync(session.jsonlPath);
				const isOriginalFilePrefixPreserved = !previousSessionBytes || sessionBytes.subarray(0, previousSessionBytes.length).equals(previousSessionBytes);
				expect(isOriginalFilePrefixPreserved && session.messages.filter(record => record.type === "assistant")
					.every(record => !record.message.id.startsWith("msg_syn_")), "native-control-file-rewritten");
				previousSessionBytes = sessionBytes;
				if (turn) observations.push({
					isOriginalFilePrefixPreserved,
					transition: `${turn}-to-${turn + 1}`, ...usageComparison(requests[turn - 1], requests[turn]),
					fidelity: compareRequestPrefix(runner.payloadFor(requests[turn - 1]), runner.payloadFor(requests[turn])),
					shapeFidelity: compareRequestPrefix(runner.payloadFor(requests[turn - 1]), runner.payloadFor(requests[turn]), false),
					beforeShapes: messageShapes(runner.payloadFor(requests[turn - 1])), afterShapes: messageShapes(runner.payloadFor(requests[turn])),
				});
			}
			const native = openSession({ sessionId: ccSessionId!, projectPath: runner.workspace.cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
			const environmentShapes = native.attachments.filter(record => record.attachment.type === "environment").map(record =>
				Object.entries(record.attachment).map(([field, value]) => ({ field, kind: Array.isArray(value) ? "array" : typeof value,
					size: typeof value === "string" || Array.isArray(value) ? value.length : null, fieldNames: value && typeof value === "object" ? Object.keys(value) : [] })));
			return { observations, environmentShapes };
		});
	},
} satisfies VerificationCheck;
