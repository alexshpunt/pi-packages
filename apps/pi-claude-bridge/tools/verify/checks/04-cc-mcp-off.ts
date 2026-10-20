import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../../src/config.js";
import { withCapturedQueries } from "../capture.js";
import { fixtureUser } from "../harness.js";
import { captureSpawn, flagValues } from "../spawn.js";
import { expect, type VerificationCheck } from "../types.js";

export default {
	name: "04-cc-mcp-off", mode: "spawn", inputs: { legacyStrictMcpConfig: false },
	expected: { strictMcpConfig: true, strictFlagCount: 1, cloudMcpDisabled: true, configUnchanged: true },
	async run(context) {
		return withCapturedQueries(context, async (harness, captures, workspace) => {
			const directory = join(workspace.cwd, ".pi");
			mkdirSync(directory);
			const path = join(directory, "claude-bridge.json");
			const config = JSON.stringify({ provider: { strictMcpConfig: false } });
			writeFileSync(path, config);
			harness.runtime.providerSettings = loadConfig(workspace.cwd).provider ?? {};
			await harness.turn({ messages: [fixtureUser("MCP loading fixture.")], tools: [] });
			await harness.waitForIdle();
			const options = captures[0].options;
			const capture = await captureSpawn(options, workspace);
			const observed = { strictMcpConfig: options.strictMcpConfig ?? false, strictFlagCount: flagValues(capture.argv, "strict-mcp-config").length, cloudMcpDisabled: capture.env.ENABLE_CLAUDEAI_MCP_SERVERS === "0", configUnchanged: readFileSync(path, "utf8") === config };
			expect(observed.strictMcpConfig && observed.strictFlagCount === 1 && observed.cloudMcpDisabled && observed.configUnchanged, "04-cc-mcp-not-disabled", observed);
			return observed;
		});
	},
} satisfies VerificationCheck;
