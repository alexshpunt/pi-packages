#!/usr/bin/env node

/**
 * Gaps the agent_start capture does NOT close, pinned so the boundary is explicit.
 *
 * The agent_start record keys the prompt pi renders from the final before_agent_start
 * options (ctx.getSystemPrompt()), carrying the stashed portable parts. That fixes the
 * widened-dispatch case (see unit-agent-start-capture.mjs). The reported failure shapes
 * that still fall outside it:
 *
 * 1. Tail-stripped inheritance (issue #88): a child embedding its parent prompt minus
 *    pi's per-session tail (skills catalogue, cwd footer) matches no full-prompt key, so
 *    nothing is projected for that child. The shape remains unsupported, but the
 *    sendability guard fails with its diagnostic instead of silently forwarding pi's
 *    harness. (gotgenes/pi-subagents strips the tail; elidickinson/pi-subagents embeds
 *    verbatim and is covered by the agent_start record.)
 * 2. A prompt composed entirely outside pi's before_agent_start pipeline (issue #102's
 *    pi-web-ui shape) is neither a rendered-options key, a handler-returned force
 *    (which agent_start does capture — see the force test below), nor an embedding.
 * 3. A prompt that changes AFTER turn_start (issue #91's remaining shape): turn_start
 *    re-keys every turn (first included), but a prompt rewritten between turn_start and
 *    the stream call — an extension context-event handler or a forced-prompt projection
 *    on newer pi — is seen by no boundary.
 */

import { describe, expect, it } from "vitest";
import { PI_PREAMBLE, projectPromptCapture } from "../src/prompt-capture.js";
import { activateWithMockPi } from "./lib/mock-pi.mjs";

const { __test } = await import("../src/index.js");

const section = (name, content) => `<${name}>\n${content}\n</${name}>`;
const parentSections = [
	`${PI_PREAMBLE}, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`,
	section("tools", "- read: Read a file\n- bash: Run commands\n\nIn addition to the tools above, you may have access to other custom tools depending on the project."),
	section("rules", "- Use bash for file operations like ls, rg, find\n- Be concise in your responses"),
	section("docs", "Pi documentation (read only when the user asks about pi itself):\n- Main documentation: /pi/README.md"),
	section("project_context", "Project-specific instructions and guidelines:\n\n<project_instructions path=\"/parent/AGENTS.md\">\nParent rules.\n</project_instructions>"),
	section("skills", "The following skills provide specialized instructions for specific tasks.\n\n<available_skills>\n  <skill>\n    <name>deploy</name>\n    <description>Deploy the application.</description>\n  </skill>\n</available_skills>"),
	section("cwd", "/parent"),
];
const PARENT_PROMPT = parentSections.join("\n\n");
const STRIPPED_PARENT = parentSections.slice(0, 5).join("\n\n");
const CHILD_WRAPPER = `<active_agent name=\"Explore\"/>\n\n# Environment\nWorking directory: /child\nGit repository: yes\nBranch: main\nPlatform: darwin`;
const STRIPPED_CHILD = `${STRIPPED_PARENT}\n\n${CHILD_WRAPPER}`;

describe("agent_start capture — documented gaps", () => {
	it("makes isolated subagent captures resolve via the shared registry (#64)", async () => {
		const parent = activateWithMockPi();
		// An isolated agent re-evaluates the module; its records land in the same
		// process-wide registry the pinned stream resolves against.
		const { default: activateFresh, __test: freshTest } = await import("../src/index.js?isolated-child");
		const child = activateWithMockPi(activateFresh);

		const isolatedPrompt = "You are an isolated smoke-test agent. Respond with ZZ_ISO_OK.";
		child.get("before_agent_start")({ systemPrompt: isolatedPrompt, systemPromptOptions: {} });
		child.get("agent_start")({}, { getSystemPrompt: () => isolatedPrompt });

		expect(freshTest.promptCaptures.resolve(isolatedPrompt), "the child instance recorded its own prompt").toBeTruthy();
		expect(__test.promptCaptures.resolveOrDerive(isolatedPrompt), "the shared registry the pinned stream resolves against resolves the child's prompt").toBeTruthy();
		expect(freshTest.promptCaptures, "both instances share one capture registry").toBe(__test.promptCaptures);
	});

	it("does not match a child embedding a tail-stripped parent prompt (#88)", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: PARENT_PROMPT, systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => PARENT_PROMPT });

		// gotgenes/pi-subagents inheritedIdentity embeds the parent minus the per-session tail.
		expect(() => __test.promptCaptures.resolveOrDerive(STRIPPED_CHILD), "the full assembled prompt is not a substring of its tail-stripped embedding").toThrow(/no capture/);
	});

	it("fails loudly when a recorded tail-stripped child has no inheritance edge (#88)", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: PARENT_PROMPT, systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => PARENT_PROMPT });

		// The child is recorded at both production capture boundaries, but its custom
		// prompt contains only the tail-stripped parent shape, so no edge is matched.
		handlers.get("before_agent_start")({
			systemPrompt: STRIPPED_CHILD,
			systemPromptOptions: { customPrompt: STRIPPED_CHILD },
		});
		handlers.get("agent_start")({}, { getSystemPrompt: () => STRIPPED_CHILD });

		const capture = __test.promptCaptures.resolve(STRIPPED_CHILD);
		expect(capture, "the tail-stripped child must be recorded before projection").toBeTruthy();
		expect(capture.inherited.length, "the unsupported embedding must not invent an inheritance edge").toBe(0);
		expect(() => projectPromptCapture(capture, { skillReadTool: "none" }), "an unmatched recorded child must fail before its harness reaches Claude Code").toThrow(/prompt-capture: refusing to send this prompt/);
	});

	it("does capture a handler-returned wholesale replacement: it resolves via the agent_start key", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: "pi rendered prompt", systemPromptOptions: {} });
		// A before_agent_start handler that RETURNS a system prompt forces it as the request
		// head, and pi renders ctx.getSystemPrompt() as exactly that forced text
		// (buildSystemPromptState returns forceSystemPrompt verbatim).
		handlers.get("agent_start")({}, { getSystemPrompt: () => "forced replacement prompt owning the request head" });

		const capture = __test.promptCaptures.resolve("forced replacement prompt owning the request head");
		expect(capture, "the forced text becomes a capture key at agent_start").toBeTruthy();
		// Caveat pinned by design: only the portable parts are projected for Claude Code;
		// the forced text's own novel prose is not forwarded (forwarding pi-harness-shaped
		// prose would trip the server's third-party gate).
	});

	it("does not rescue a prompt composed outside the before_agent_start pipeline (#102 shape)", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: "pi rendered prompt", systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => "pi rendered prompt" });

		// A host composing the prompt from its own template outside pi's pipeline —
		// neither a rendered-options key, a handler-returned force, nor an embedding.
		expect(() => __test.promptCaptures.resolveOrDerive("host-composed prompt owning the request head"), "out-of-pipeline composition is neither a recorded key nor an embedding of one").toThrow(/no capture/);
	});

	it("does not see a prompt replaced between turn_start and the stream call (#91 remaining shape)", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: "turn-1 prompt", systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => "turn-1 prompt" });
		handlers.get("turn_start")({}, { getSystemPrompt: () => "turn-2 rendered prompt" });
		expect(__test.promptCaptures.resolveOrDerive("turn-2 rendered prompt"), "the turn_start record resolves").toBeTruthy();

		// A rewrite landing after turn_start — a context-event handler replacing the
		// system message, or a forced-prompt projection on newer pi — is seen by no
		// recording boundary. When it neither is nor embeds a known key, it throws.
		expect(() => __test.promptCaptures.resolveOrDerive("replacement head installed by a context handler"), "post-turn_start rewrites are seen by no recording boundary").toThrow(/no capture/);
	});
});
