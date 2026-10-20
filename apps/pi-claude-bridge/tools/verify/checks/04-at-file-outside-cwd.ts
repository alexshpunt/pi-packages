import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureUser } from "../harness.js";
import { withLiveRunner } from "../live.js";
import { fingerprint } from "../report.js";
import { expect, type VerificationCheck } from "../types.js";

export default {
	name: "04-at-file-outside-cwd", mode: "live", inputs: { outsideFile: "owned temporary sibling of cwd", nativeTools: [] },
	expected: { fileExpandedInModelRequest: true, markerReturned: true },
	async run(context) {
		return withLiveRunner(context, async runner => {
			const marker = `outside-${randomUUID()}`;
			const file = join(runner.workspace.root, "outside.txt");
			writeFileSync(file, `Verification value: ${marker}\n`);
			const result = await runner.turn({ messages: [fixtureUser(`Read @${file} and reply only with its verification value.`)], tools: [] });
			await runner.harness.waitForIdle();
			const answer = result.content.filter(block => block.type === "text").map(block => block.text).join("");
			const observed = {
				permissionMode: runner.queryOptions()[0]?.permissionMode,
				fileExpandedInModelRequest: runner.requests.some(request => JSON.stringify(runner.payloadFor(request)).includes(marker)),
				markerReturned: answer.includes(marker), finalAnswer: fingerprint(answer),
			};
			expect(observed.fileExpandedInModelRequest && observed.markerReturned, "04-outside-file-not-expanded", observed);
			return observed;
		});
	},
} satisfies VerificationCheck;
