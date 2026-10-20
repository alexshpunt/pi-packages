import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBridgeModels } from "../src/models.js";
import {
	buildProviderRequestOptions, buildSummaryRequestOptions, effortForReasoning, thinkingForReasoning,
} from "../src/cc/request-options.js";

const models = getBridgeModels();
const model = id => { const found = models.find(item => item.id === id); assert.ok(found, id); return found; };

describe("reasoning request options", () => {
	it("preserves the generic effort table and omitted/off defaults", () => {
		const fixture = { id: "claude-opus-4-5", reasoning: true };
		for (const [reasoning, effort] of [[undefined, undefined], ["off", undefined], ["minimal", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "max"], ["max", "max"]]) {
			assert.equal(effortForReasoning(fixture, reasoning), effort);
		}
	});
	it("prefers catalog effort overrides, including null and invalid entries", () => {
		const fixture = { id: "claude-opus-4-8", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max", low: null, medium: "unsupported" } };
		assert.equal(effortForReasoning(fixture, "xhigh"), "xhigh");
		assert.equal(effortForReasoning(fixture, "max"), "max");
		assert.equal(effortForReasoning(fixture, "low"), undefined);
		assert.equal(effortForReasoning(fixture, "medium"), undefined);
		assert.equal(effortForReasoning(fixture, "minimal"), "low");
	});
	it("explicitly requests summarized adaptive thinking for modern catalog models", () => {
		for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-8", "claude-fable-5", "claude-haiku-5-5"]) {
			assert.deepEqual(thinkingForReasoning(model(id), "high"), { type: "adaptive", display: "summarized" });
		}
	});
	it("does not fabricate adaptive support for old or unrecognized model ids", () => {
		for (const id of ["claude-3-7-sonnet", "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5", "custom-model"]) {
			assert.equal(thinkingForReasoning({ id, reasoning: true }, "high"), undefined);
		}
	});
	it("does not enable thinking for a non-reasoning model", () => {
		assert.equal(thinkingForReasoning({ id: "claude-haiku-5-5", reasoning: false }, "high"), undefined);
		assert.equal(thinkingForReasoning({ id: "claude-haiku-5-5", reasoning: false }, undefined), undefined);
	});
	it("disables both omitted and explicit off when supported", () => {
		for (const reasoning of [undefined, "off"]) {
			assert.deepEqual(thinkingForReasoning(model("claude-opus-4-8"), reasoning), { type: "disabled" });
			assert.deepEqual(thinkingForReasoning(model("claude-opus-4-5"), reasoning), { type: "disabled" });
		}
	});
	it("preserves the always-thinking exception, including current Haiku 5.5", () => {
		for (const reasoning of [undefined, "off"]) {
			assert.equal(thinkingForReasoning(model("claude-haiku-5-5"), reasoning), undefined);
			assert.equal(thinkingForReasoning(model("claude-fable-5"), reasoning), undefined);
		}
	});
	it("shares adaptive thinking and effort between provider and isolated summary", () => {
		const input = { model: model("claude-haiku-5-5"), cliModel: "claude-haiku-5-5", reasoning: "high", systemPrompt: "fixture" };
		for (const build of [buildProviderRequestOptions, buildSummaryRequestOptions]) {
			const options = build(input);
			assert.deepEqual(options.thinking, { type: "adaptive", display: "summarized" });
			assert.equal(options.effort, "high");
			assert.equal(options.extraArgs?.["thinking-display"], undefined);
		}
		assert.equal(buildSummaryRequestOptions(input).systemPrompt, "fixture");
	});
	it("preserves legacy provider display and summary defaults", () => {
		for (const id of ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"]) {
			const input = { model: model(id), cliModel: id, reasoning: "high" };
			assert.equal(buildProviderRequestOptions(input).thinking, undefined);
			assert.equal(buildProviderRequestOptions(input).extraArgs["thinking-display"], "summarized");
			assert.equal(buildSummaryRequestOptions(input).thinking, undefined);
			assert.equal(buildSummaryRequestOptions(input).extraArgs, undefined);
		}
	});
	it("uses one typed model option and refreshable preset prompts", () => {
		const input = { model: model("claude-haiku-5-5"), cliModel: "claude-haiku-5-5[1m]", reasoning: "high", systemPrompt: "current append" };
		const provider = buildProviderRequestOptions(input);
		assert.equal(provider.model, input.cliModel);
		assert.equal(provider.extraArgs?.model, undefined);
		assert.deepEqual(provider.systemPrompt, { type: "preset", preset: "claude_code", snapshot: false, append: input.systemPrompt });
		assert.deepEqual(buildProviderRequestOptions({ ...input, systemPrompt: undefined }).systemPrompt, {
			type: "preset", preset: "claude_code", snapshot: false, append: undefined,
		});
	});
	it("keeps isolated summary prompts custom strings without snapshot policy", () => {
		const input = { model: model("claude-haiku-5-5"), cliModel: "claude-haiku-5-5[1m]", systemPrompt: "custom summary" };
		const summary = buildSummaryRequestOptions(input);
		assert.equal(summary.model, input.cliModel);
		assert.equal(summary.extraArgs?.model, undefined);
		assert.equal(summary.systemPrompt, input.systemPrompt);
	});
});
