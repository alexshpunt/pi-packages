import { describe, expect, it } from "vitest";
import { renderSkillsBlock } from "../src/features/prompt/skills.js";

function skill(name, { disabled = false } = {}) {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: { source: "test", scope: "temporary", origin: "top-level" },
		disableModelInvocation: disabled,
	};
}

describe("skills block rendering", () => {
	it("formats skills and names the MCP read tool for provider queries", () => {
		const result = renderSkillsBlock([skill("browser")], "mcp");
		expect(result?.startsWith("The following skills")).toBeTruthy();
		expect(result).toMatch(/Use the read tool \(mcp__custom-tools__read\)/);
		expect(result).toMatch(/<location>\/skills\/browser\/SKILL\.md<\/location>/);
	});

	it("emits nothing without a usable reader or visible skills", () => {
		expect(renderSkillsBlock([skill("browser")], "none")).toBe(undefined);
		expect(renderSkillsBlock([], "mcp")).toBe(undefined);
		expect(renderSkillsBlock([skill("hidden", { disabled: true })], "mcp")).toBe(undefined);
	});

	it("uses Pi's XML escaping", () => {
		const escaped = skill("browser");
		escaped.description = "read <this> & that";
		expect(renderSkillsBlock([escaped], "mcp")).toMatch(/read &lt;this&gt; &amp; that/);
	});
});
