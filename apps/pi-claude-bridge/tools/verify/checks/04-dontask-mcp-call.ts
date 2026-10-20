import liveSmoke from "./live-smoke.js";
import { expect, type VerificationCheck } from "../types.js";

export default {
	name: "04-dontask-mcp-call", mode: "live", inputs: { model: "claude-haiku-5-5", tool: "verify_echo" },
	expected: { permissionMode: "dontAsk", toolCalls: 1, returnedValueInFinalAnswer: true },
	async run(context) {
		const observed = await liveSmoke.run(context);
		const inits = observed.inits as { permissionMode: string }[];
		expect(inits.length > 0 && inits.every(init => init.permissionMode === "dontAsk"), "04-dontask-not-applied", observed);
		return observed;
	},
} satisfies VerificationCheck;
