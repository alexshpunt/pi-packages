import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildChildEnv } from "../../../src/adapters/claude/environment.js";
import { expect, type VerificationCheck } from "../types.js";
import { withWorkspace } from "../workspace.js";

export default {
	name: "04-env-leak", mode: "offline", inputs: { hostTrafficFlag: "absent" },
	expected: { hostFlagAbsent: true, ordinaryChildFlagAbsent: true, bridgeChildFlag: "1" },
	async run() {
		return withWorkspace(false, async () => {
			delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
			const { default: activate } = await import("../../../src/index.js");
			activate({ on() {}, registerProvider() {} } as unknown as ExtensionAPI);
			const child = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC))"], { encoding: "utf8" });
			const observed = { hostFlagAbsent: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined, ordinaryChildFlagAbsent: child === "undefined", bridgeChildFlag: buildChildEnv().CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC };
			expect(observed.hostFlagAbsent && observed.ordinaryChildFlagAbsent && observed.bridgeChildFlag === "1", "04-host-env-leak", observed);
			return observed;
		});
	},
} satisfies VerificationCheck;
