import { withCapturedQueries } from "../capture.js";
import { fixtureUser } from "../harness.js";
import { expect, type VerificationCheck } from "../types.js";

export default {
	name: "04-permission-mode", mode: "offline", inputs: { model: "claude-haiku-5-5" },
	expected: { permissionMode: "dontAsk", allowedTools: ["mcp__custom-tools"], tools: [] },
	async run(context) {
		return withCapturedQueries(context, async (harness, captures) => {
			await harness.turn({ messages: [fixtureUser("Permission fixture.")], tools: [] });
			await harness.waitForIdle();
			const { permissionMode, allowedTools, tools } = captures[0].options;
			const observed = { permissionMode, allowedTools: allowedTools ?? [], tools };
			expect(permissionMode === "dontAsk" && JSON.stringify(allowedTools) === '["mcp__custom-tools"]' && Array.isArray(tools) && tools.length === 0, "04-permission-policy-mismatch", observed);
			return observed;
		});
	},
} satisfies VerificationCheck;
