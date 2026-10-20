import { withCapturedQueries } from "../capture.js";
import { fixtureUser } from "../harness.js";
import { captureSpawn } from "../spawn.js";
import { expect, type VerificationCheck } from "../types.js";

const markers = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SESSION_ID", "CLAUDE_EFFORT", "CLAUDE_PID"];
const forwarded = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

export default {
	name: "04-parent-markers", mode: "spawn", inputs: { parentMarkers: markers, syntheticAuth: true },
	expected: { inheritedMarkers: [], entrypoint: "sdk-ts", callerAuthPreserved: true },
	async run(context) {
		return withCapturedQueries(context, async (harness, captures, workspace) => {
			for (const key of markers) process.env[key] = key === "CLAUDE_CODE_ENTRYPOINT" ? "cli" : "fixture-parent";
			for (const key of forwarded) process.env[key] = "fixture-preserved";
			await harness.turn({ messages: [fixtureUser("Parent marker fixture.")], tools: [] });
			await harness.waitForIdle();
			const capture = await captureSpawn(captures[0].options, workspace, [...markers, ...forwarded, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTO_COMPACT", "ENABLE_CLAUDEAI_MCP_SERVERS"]);
			const inheritedMarkers = markers.filter(key => key !== "CLAUDE_CODE_ENTRYPOINT" && capture.env[key] !== undefined);
			const observed = {
				inheritedMarkers, entrypoint: capture.env.CLAUDE_CODE_ENTRYPOINT,
				callerAuthPreserved: forwarded.every(key => capture.env[key] === "fixture-preserved"),
				trafficDisabled: capture.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === "1",
				autoCompactDisabled: capture.env.DISABLE_AUTO_COMPACT === "1", cloudMcpDisabled: capture.env.ENABLE_CLAUDEAI_MCP_SERVERS === "0",
				hostMarkersUnchanged: markers.every(key => process.env[key] === (key === "CLAUDE_CODE_ENTRYPOINT" ? "cli" : "fixture-parent")),
			};
			expect(!inheritedMarkers.length && observed.entrypoint === "sdk-ts" && observed.callerAuthPreserved && observed.trafficDisabled && observed.autoCompactDisabled && observed.cloudMcpDisabled && observed.hostMarkersUnchanged, "04-parent-markers-inherited", observed);
			return observed;
		});
	},
} satisfies VerificationCheck;
