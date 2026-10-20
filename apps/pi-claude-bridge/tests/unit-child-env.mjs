/**
 * Every Claude Code subprocess the bridge spawns has to be told to keep its hands
 * off state pi owns. These are silent when missing: CC compacts or writes memory
 * on its own, nothing throws, and the damage shows up in the user's ~/.claude
 * rather than in a test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");
const { buildChildEnv } = await import("../src/cc/env.js");

describe("Claude Code child environment", () => {
	it("disables auto-compaction and claude.ai MCP servers", () => {
		assert.deepEqual(__test.CC_CHILD_ENV, {
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
		});
	});

	it("removes parent session markers without mutating the caller environment", () => {
		const keys = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SESSION_ID", "CLAUDE_EFFORT", "CLAUDE_PID"];
		const original = Object.freeze(Object.fromEntries(keys.map(key => [key, "parent-fixture"])));
		const child = buildChildEnv(original);
		for (const key of keys) {
			assert.equal(Object.hasOwn(child, key), false, key);
			assert.equal(original[key], "parent-fixture");
		}
	});

	it("retains auth, routing, and unrelated caller choices", () => {
		const original = Object.freeze({ ANTHROPIC_BASE_URL: "https://fixture.invalid", ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_AUTH_TOKEN: "fixture-auth", CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", PATH: "/fixture/bin", CLAUDE_CODE_FUTURE_OPTION: "keep", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" });
		const child = buildChildEnv(original);
		for (const [key, value] of Object.entries(original)) if (key !== "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC") assert.equal(child[key], value);
		assert.equal(child.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
		assert.equal(original.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "0");
	});

	// Final SDK argv/env application is checked by the verification CLI, not a source grep.
});
