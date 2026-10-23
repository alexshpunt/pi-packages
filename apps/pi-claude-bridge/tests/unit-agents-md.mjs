import { describe, expect, it } from "vitest";
import { formatProjectContext } from "../src/features/prompt/project-context.js";

describe("project context forwarding", () => {
	it("preserves Pi's file order and labels each with its path", () => {
		const prompt = formatProjectContext([
			{ path: "/agent/AGENTS.md", content: "global instructions" },
			{ path: "/project/CLAUDE.md", content: "parent instructions" },
			{ path: "/project/nested/AGENTS.md", content: "nested instructions" },
		]);

		expect(prompt).toMatch(/^<project_context>\n\nProject-specific instructions and guidelines:/);
		expect(prompt.indexOf("global instructions") < prompt.indexOf("parent instructions")).toBeTruthy();
		expect(prompt.indexOf("parent instructions") < prompt.indexOf("nested instructions")).toBeTruthy();
		expect(prompt).toMatch(/<project_instructions path="\/project\/CLAUDE\.md">/);
	});

	it("returns undefined when Pi finds no context files", () => {
		expect(formatProjectContext([])).toBe(undefined);
	});
});
