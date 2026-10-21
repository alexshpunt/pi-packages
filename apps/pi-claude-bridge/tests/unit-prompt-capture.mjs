#!/usr/bin/env node

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectPromptSkills, PI_PREAMBLE, projectPromptCapture, PromptCaptures } from "../src/prompt-capture.js";

const PI_SYSTEM_PROMPT = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url));

const PI_HARNESS = "You are an expert coding assistant operating inside pi. Pi documentation: pi packages (docs/packages.md).";
const PARENT_KEY = `${PI_HARNESS}\n\n<project_context>raw parent context</project_context>\nCurrent working directory: /parent`;
const CHILD_SUFFIX = `\n\n<sub_agent_context>child rules</sub_agent_context>\n\n<active_agent name="Plan"/>\n\n# Environment\nWorking directory: /child\n\n<agent_instructions>plan carefully</agent_instructions>`;
const CHILD_KEY = `${PARENT_KEY}${CHILD_SUFFIX}\nCurrent working directory: /child`;

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

function capture(overrides = {}) {
	return { contextFiles: [], skills: [], ...overrides };
}

function project(captures, key, skillReadTool = "mcp") {
	const found = captures.resolve(key);
	expect(found, `missing capture for ${key.slice(0, 30)}`).toBeTruthy();
	return projectPromptCapture(found, { skillReadTool });
}

function occurrences(text, needle) {
	return text.split(needle).length - 1;
}

describe("PromptCaptures", () => {
	it("keeps parent and child captures isolated", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));

		expect(captures.resolve(PARENT_KEY).contextFiles.length).toBe(1);
		expect(captures.resolve(CHILD_KEY).contextFiles.length).toBe(0);
		expect(captures.resolve("unknown")).toBe(undefined);
		expect(captures.resolve(undefined)).toBe(undefined);
	});

	it("derives a transient capture when a later extension wrapped the prompt", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({
			contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }],
			skills: [skill("browser")],
		}));

		// What an extension loading after the bridge produces: our recorded prompt,
		// wrapped in text we never saw.
		const wrapped = `PREFIX FROM ANOTHER EXTENSION\n\n${PARENT_KEY}\n\nSUFFIX`;
		const derived = captures.resolveOrDerive(wrapped);
		const projected = projectPromptCapture(derived, { skillReadTool: "mcp" });

		expect(projected, "the wrapped prompt's own instructions must survive").toMatch(/parent rules/);
		expect(projected, "and so must its skills").toMatch(/browser/);
		// The wrapper's own text is instruction too. Substituting the embedded prompt
		// while discarding what surrounds it would be the silent loss the throw exists
		// to prevent — accept the prompt whole or refuse it, never accept and discard.
		expect(projected, "the wrapper's prefix must survive").toMatch(/PREFIX FROM ANOTHER EXTENSION/);
		expect(projected, "and so must its suffix").toMatch(/SUFFIX/);
		expect(projected, "but never Pi's harness, which the projection replaces").not.toMatch(/Pi documentation/);
		expect(captures.resolve(wrapped), "a derived capture is not retained").toBe(undefined);
	});

	it("revives an exact capture whose lookup key was evicted", () => {
		const captures = new PromptCaptures(2);
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));
		// A child keeps the parent node alive by reference even once its key is gone.
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		// Evicts PARENT_KEY's lookup key while the child keeps the node itself alive.
		captures.record("unrelated", capture());
		expect(captures.resolve(PARENT_KEY), "precondition: the key is gone").toBe(undefined);

		// findInheritedPrompts skips a node whose key IS the prompt, so an evicted
		// exact match would otherwise embed nothing and throw.
		const revived = captures.resolveOrDerive(PARENT_KEY);
		expect(revived.contextFiles[0].content).toBe("parent rules");
		// Revival re-adds a key that was not in the map, so it has to trim like a write.
		expect(captures.size, "reviving must not grow the map past its bound").toBe(2);
	});

	it("keeps a parent alive that is only ever resolved, never re-recorded", () => {
		// The real shape: one long-lived parent agent, then a stream of sub-agents
		// each recording a prompt of its own. Counting only writes ages the parent out.
		const captures = new PromptCaptures(4);
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));

		for (let i = 0; i < 8; i++) {
			expect(captures.resolve(PARENT_KEY), `parent evicted after ${i} sub-agents`).toBeTruthy();
			captures.record(`sub-agent prompt ${i}`, capture());
		}

		expect(captures.resolve(PARENT_KEY), "the parent must survive its own sub-agents").toBeTruthy();
		expect(captures.resolve(PARENT_KEY).contextFiles.length).toBe(1);
	});

	it("throws rather than silently dropping instructions it cannot account for", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));

		expect(() => captures.resolveOrDerive("a prompt sharing nothing with what we recorded")).toThrow(/no capture for this .* system prompt/);
		// No prompt at all is not a loss — there is nothing to forward.
		expect(captures.resolveOrDerive(undefined)).toBe(undefined);
	});

	it("reports the closest known capture when a prompt matches nothing", () => {
		const diagnostics = [];
		const captures = new PromptCaptures(64, (d) => diagnostics.push(d));
		captures.record("prefix-common-THE-REST", capture());

		let error;
		try {
			captures.resolveOrDerive("prefix-common-WHO-ARE-YOU");
		} catch (e) {
			error = e;
		}

		expect(String(error?.message)).toMatch(/diverges at offset 14 \(22-char key\)/);
		expect(diagnostics.length).toBe(1);
		expect(diagnostics[0].matches[0].key).toBe("prefix-common-THE-REST");
		expect(diagnostics[0].matches[0].firstDivergent).toBe(14);
	});

	it("names pi#5581 when a prompt is a recorded key with its tail missing", () => {
		const captures = new PromptCaptures();
		// The issue #144 shape: the next turn's prompt is the last recorded key with the
		// extension's additions gone, because the idle triggerTurn skipped before_agent_start.
		captures.record(`${PARENT_KEY}\n\n<skills>extension additions</skills>`, capture(), "turn_start");

		expect(() => captures.resolveOrDerive(PARENT_KEY)).toThrow(/pi#5581/);
	});

	it("recursively projects an inherited prompt without Pi's harness", () => {
		const browser = skill("browser");
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({
			contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }],
			skills: [browser],
		}));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, skills: [browser] }));

		const parent = project(captures, PARENT_KEY);
		const child = project(captures, CHILD_KEY);
		expect(child.startsWith(parent), "child should retain the parent's projected cache prefix").toBeTruthy();
		expect(child).not.toMatch(/operating inside pi|pi packages/);
		expect(child).toMatch(/parent rules/);
		expect(child).toMatch(/<sub_agent_context>child rules<\/sub_agent_context>/);
		expect(child).toMatch(/<active_agent name="Plan"\/>/);
		expect(child).toMatch(/<agent_instructions>plan carefully<\/agent_instructions>/);
		expect(occurrences(child, "/skills/browser/SKILL.md")).toBe(1);
	});

	it("leaves direct custom and replace-mode prompts byte-identical", () => {
		const captures = new PromptCaptures();
		captures.record("direct assembled", capture({ custom: "  direct user instructions\n" }));
		captures.record("replace assembled", capture({ custom: "<active_agent name=\"review\"/>\nreplace instructions" }));

		expect(project(captures, "direct assembled")).toBe("  direct user instructions\n");
		expect(project(captures, "replace assembled")).toBe("<active_agent name=\"review\"/>\nreplace instructions");
	});

	it("uses the longest inherited key for nested agents", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		const grandSuffix = "\n\n<sub_agent_context>grandchild rules</sub_agent_context>";
		const grandKey = `${CHILD_KEY}${grandSuffix}\nCurrent working directory: /grandchild`;
		captures.record(grandKey, capture({ custom: `${CHILD_KEY}${grandSuffix}` }));

		const grandchild = project(captures, grandKey);
		expect(grandchild).not.toMatch(/operating inside pi|Current working directory: \/parent|Current working directory: \/child/);
		expect(occurrences(grandchild, "parent rules")).toBe(1);
		expect(grandchild).toMatch(/child rules/);
		expect(grandchild).toMatch(/grandchild rules/);
	});

	it("retains inherited nodes after their lookup keys are evicted", () => {
		const captures = new PromptCaptures(2);
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "survives eviction" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		captures.record("unrelated", capture());

		expect(captures.resolve(PARENT_KEY)).toBe(undefined);
		expect(project(captures, CHILD_KEY)).toMatch(/survives eviction/);
	});

	it("relinks an evicted ancestor through the live inheritance graph", () => {
		const captures = new PromptCaptures(2);
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "reachable ancestor" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		captures.record("unrelated", capture());
		const changedKey = "changed child assembled prompt";
		captures.record(changedKey, capture({ custom: `${PARENT_KEY}\n\nchanged child rules` }));

		const changed = project(captures, changedKey);
		expect(changed).not.toMatch(/operating inside pi/);
		expect(changed).toMatch(/reachable ancestor/);
		expect(changed).toMatch(/changed child rules/);
	});

	it("updates descendants through a re-recorded parent node", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "rules v1" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "rules v2" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, append: "child append" }));

		const child = project(captures, CHILD_KEY);
		expect(child).not.toMatch(/rules v1|operating inside pi/);
		expect(child).toMatch(/rules v2/);
		expect(child).toMatch(/child append$/);
	});

	it("projects every non-overlapping occurrence of an inherited prompt", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "repeated rules" }] }));
		const repeatedCustom = `${PARENT_KEY}\nseparator\n${PARENT_KEY}`;
		captures.record("repeated child", capture({ custom: repeatedCustom }));

		const result = project(captures, "repeated child");
		expect(result).not.toMatch(/operating inside pi/);
		expect(occurrences(result, "repeated rules")).toBe(2);
	});

	it("deduplicates inherited skills and preserves child-only skills", () => {
		const browser = skill("browser");
		const review = skill("review");
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ skills: [browser] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, skills: [browser, review] }));

		const childCapture = captures.resolve(CHILD_KEY);
		expect(collectPromptSkills(childCapture).map(({ name }) => name)).toStrictEqual(["browser", "review"]);
		const result = projectPromptCapture(childCapture, { skillReadTool: "mcp" });
		expect(occurrences(result, "/skills/browser/SKILL.md")).toBe(1);
		expect(occurrences(result, "/skills/review/SKILL.md")).toBe(1);
	});

	it("allows an enabled child skill when the inherited copy is hidden", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ skills: [skill("browser", { disabled: true })] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, skills: [skill("browser")] }));
		expect(occurrences(project(captures, CHILD_KEY), "/skills/browser/SKILL.md")).toBe(1);
	});

	it("is bounded and evicts the least-recently-recorded key", () => {
		const captures = new PromptCaptures(3);
		captures.record("a", capture());
		captures.record("b", capture());
		captures.record("c", capture());
		captures.record("a", capture({ custom: "refreshed" }));
		captures.record("d", capture());

		expect(captures.size).toBe(3);
		expect(captures.resolve("b")).toBe(undefined);
		expect(captures.resolve("a").custom).toBe("refreshed");
		expect(captures.resolve("c") && captures.resolve("d")).toBeTruthy();
	});
});

describe("prompt sections", () => {
	const MCP_CONTENT = "- mcp__github (codemode): GitHub tools";
	const MCP_SECTION = `<mcp_servers>\n${MCP_CONTENT}\n</mcp_servers>`;

	it("projects a recorded section after the appended instructions, in pi's wrapper format", async () => {
		const captures = new PromptCaptures();
		captures.record("sectioned prompt", capture({
			append: "be careful",
			sections: { mcp_servers: MCP_CONTENT },
		}));

		expect(project(captures, "sectioned prompt")).toBe(`be careful\n\n${MCP_SECTION}`);

		// pi's own renderer: the projection has to be byte-identical to the text the
		// builder put into the prompt this capture keys.
		expect(existsSync(PI_SYSTEM_PROMPT), `pi's system prompt module is not at ${PI_SYSTEM_PROMPT}; if pi moved it, update this test`).toBeTruthy();
		const { buildSystemPromptSections } = await import(PI_SYSTEM_PROMPT);
		expect(buildSystemPromptSections({ cwd: "/w", sections: { mcp_servers: MCP_CONTENT } }).mcp_servers).toBe(MCP_SECTION);
	});

	it("skips an empty section, as pi's builder does", () => {
		const captures = new PromptCaptures();
		captures.record("one empty section", capture({ sections: { mcp_servers: "", other: "kept" } }));

		expect(project(captures, "one empty section")).toBe("<other>\nkept\n</other>");
	});

	it("keeps the recorded sections when the caller mutates its own map", () => {
		// systemPromptOptions is a live object: later before_agent_start handlers edit it.
		const sections = { mcp_servers: MCP_CONTENT };
		const captures = new PromptCaptures();
		captures.record("live options", capture({ sections }));
		sections.mcp_servers = "mutated";

		expect(project(captures, "live options")).toBe(MCP_SECTION);
	});

	it("drops a section a later recording no longer carries", () => {
		const captures = new PromptCaptures();
		captures.record("sectioned prompt", capture({ sections: { mcp_servers: MCP_CONTENT } }));
		expect(project(captures, "sectioned prompt")).toBe(MCP_SECTION);

		captures.record("sectioned prompt", capture({ sections: {} }));
		expect(project(captures, "sectioned prompt")).toBe(undefined);
	});

	it("projects an inherited prompt's section through a child, once", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({
			contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }],
			sections: { mcp_servers: MCP_CONTENT },
		}));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));

		const child = project(captures, CHILD_KEY);
		expect(occurrences(child, MCP_SECTION)).toBe(1);
		expect(child).not.toMatch(/operating inside pi/);
	});

	it("refuses a section carrying pi's preamble or Anthropic's trigger pair", () => {
		const offending = {
			leaked_harness: `${PI_PREAMBLE}, a coding agent harness.`,
			triggers: "see docs/custom-provider.md and docs/packages.md",
		};
		for (const [name, content] of Object.entries(offending)) {
			const captures = new PromptCaptures();
			captures.record("guarded prompt", capture({ sections: { [name]: content } }), "before_agent_start");

			expect(() => projectPromptCapture(captures.resolve("guarded prompt"), { skillReadTool: "none" }), `the ${name} section must be checked on its own`).toThrow(expect.toSatisfy((error) => error.message.includes(`in the ${name} section`)));
		}
	});
});

describe("capture provenance", () => {
	it("records which boundary last wrote a key", () => {
		const captures = new PromptCaptures();
		captures.record("key", capture(), "agent_start");

		expect(captures.resolve("key").source).toBe("agent_start");
		captures.record("key", capture(), "turn_start");
		expect(captures.resolve("key").source, "a re-record replaces the earlier source").toBe("turn_start");
	});

	it("names the closest match's boundary in a throw", () => {
		const captures = new PromptCaptures();
		captures.record("prefix-common-THE-REST", capture(), "agent_start");

		expect(() => captures.resolveOrDerive("prefix-common-WHO-ARE-YOU"), "the diagnostic must say which boundary last recorded the closest known prompt").toThrow(/recorded at agent_start/);
	});
});
