// Shared environment policy for Claude Code children, never the host process.
export const CC_CHILD_ENV = {
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
} as const;

const PARENT_CLAUDE_ENV_KEYS = [
	"CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT",
	"CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_MESSAGING_SOCKET",
	"CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SESSION_ID",
	"CLAUDE_EFFORT", "CLAUDE_PID",
] as const;

export function buildChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = { ...baseEnv, ...CC_CHILD_ENV };
	// Only parent-session state is removed. Auth, provider routing and unknown
	// caller variables remain intact; the SDK supplies its own entrypoint.
	for (const key of PARENT_CLAUDE_ENV_KEYS) delete env[key];
	return env;
}
