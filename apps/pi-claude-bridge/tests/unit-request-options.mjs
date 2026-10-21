import { describe, expect, it } from "vitest";
import { getBridgeModels } from "../src/models.js";
import {
	buildProviderRequestOptions, buildSummaryRequestOptions, effortForReasoning, thinkingForReasoning,
} from "../src/cc/request-options.js";

const models = getBridgeModels();
const model = id => { const found = models.find(item => item.id === id); expect(found, id).toBeTruthy(); return found; };

describe("reasoning request options", () => {
	it("preserves the generic effort table and omitted/off defaults", () => {
		const fixture = { id: "claude-opus-4-5", reasoning: true };
		for (const [reasoning, effort] of [[undefined, undefined], ["off", undefined], ["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "max"], ["max", "max"]]) {
			expect(effortForReasoning(fixture, reasoning)).toBe(effort);
		}
	});
	it("prefers catalog effort overrides, including null and invalid entries", () => {
		const fixture = { id: "claude-opus-4-8", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max", low: null, medium: "unsupported" } };
		expect(effortForReasoning(fixture, "xhigh")).toBe("xhigh");
		expect(effortForReasoning(fixture, "max")).toBe("max");
		expect(effortForReasoning(fixture, "low")).toBe(undefined);
		expect(effortForReasoning(fixture, "medium")).toBe(undefined);
		expect(effortForReasoning(fixture, "minimal")).toBe("low");
	});
	it("explicitly requests summarized adaptive thinking for modern catalog models", () => {
		for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-8", "claude-fable-5", "claude-haiku-5-5"]) {
			expect(thinkingForReasoning(model(id), "high")).toStrictEqual({ type: "adaptive", display: "summarized" });
		}
	});
	it("does not fabricate adaptive support for old or unrecognized model ids", () => {
		for (const id of ["claude-3-7-sonnet", "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5", "custom-model"]) {
			expect(thinkingForReasoning({ id, reasoning: true }, "high")).toBe(undefined);
		}
	});
	it("does not enable thinking for a non-reasoning model", () => {
		expect(thinkingForReasoning({ id: "claude-haiku-5-5", reasoning: false }, "high")).toBe(undefined);
		expect(thinkingForReasoning({ id: "claude-haiku-5-5", reasoning: false }, undefined)).toBe(undefined);
	});
	it("disables both omitted and explicit off when supported", () => {
		for (const reasoning of [undefined, "off"]) {
			expect(thinkingForReasoning(model("claude-opus-4-8"), reasoning)).toStrictEqual({ type: "disabled" });
			expect(thinkingForReasoning(model("claude-opus-4-5"), reasoning)).toStrictEqual({ type: "disabled" });
		}
	});
	it("preserves the always-thinking exception, including current Haiku 5.5", () => {
		for (const reasoning of [undefined, "off"]) {
			expect(thinkingForReasoning(model("claude-haiku-5-5"), reasoning)).toBe(undefined);
			expect(thinkingForReasoning(model("claude-fable-5"), reasoning)).toBe(undefined);
		}
	});
	it("shares adaptive thinking and effort between provider and isolated summary", () => {
		const input = { model: model("claude-haiku-5-5"), cliModel: "claude-haiku-5-5", reasoning: "high", systemPrompt: "fixture" };
		for (const build of [buildProviderRequestOptions, buildSummaryRequestOptions]) {
			const options = build(input);
			expect(options.thinking).toStrictEqual({ type: "adaptive", display: "summarized" });
			expect(options.effort).toBe("high");
			expect(options.extraArgs?.["thinking-display"]).toBe(undefined);
		}
		expect(buildSummaryRequestOptions(input).systemPrompt).toBe("fixture");
	});
	it("preserves legacy provider display and summary defaults", () => {
		for (const id of ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"]) {
			const input = { model: model(id), cliModel: id, reasoning: "high" };
			expect(buildProviderRequestOptions(input).thinking).toBe(undefined);
			expect(buildProviderRequestOptions(input).extraArgs["thinking-display"]).toBe("summarized");
			expect(buildSummaryRequestOptions(input).thinking).toBe(undefined);
			expect(buildSummaryRequestOptions(input).extraArgs).toBe(undefined);
		}
	});
	it("uses one typed model option and refreshable preset prompts", () => {
		const input = { model: model("claude-haiku-5-5"), cliModel: "claude-haiku-5-5[1m]", reasoning: "high", systemPrompt: "current append" };
		const provider = buildProviderRequestOptions(input);
		expect(provider.model).toBe(input.cliModel);
		expect(provider.extraArgs?.model).toBe(undefined);
		expect(provider.systemPrompt).toStrictEqual({ type: "preset", preset: "claude_code", snapshot: false, append: input.systemPrompt });
		expect(buildProviderRequestOptions({ ...input, systemPrompt: undefined }).systemPrompt).toStrictEqual({
			type: "preset", preset: "claude_code", snapshot: false, append: undefined,
		});
	});
	it("keeps isolated summary prompts custom strings without snapshot policy", () => {
		const input = { model: model("claude-haiku-5-5"), cliModel: "claude-haiku-5-5[1m]", systemPrompt: "custom summary" };
		const summary = buildSummaryRequestOptions(input);
		expect(summary.model).toBe(input.cliModel);
		expect(summary.extraArgs?.model).toBe(undefined);
		expect(summary.systemPrompt).toBe(input.systemPrompt);
	});
});
