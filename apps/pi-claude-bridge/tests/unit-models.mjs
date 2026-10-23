/**
 * Tests for MODELS construction + resolveModel.
 * Pins: catalog-driven picker excludes pi-ai's dated snapshot aliases, family
 * shortcuts resolve newest-first regardless of sort order, projection strips
 * pi-ai's baseUrl/api/provider/headers, and the runtime policy gates [1m] ids
 * on measurement and plan settings.
 */
import { describe, expect, it } from "vitest";
import { applyLongContext, buildModels, claudeCodeModelId, resolveClaudeCodeRuntimeModel, resolveModel } from "../src/features/models/policy.js";
import { getModels } from "@earendil-works/pi-ai/compat";

const PRO = { plan: "pro", longContextExtraUsage: false };
const MAX = { plan: "max", longContextExtraUsage: false };
const EXTRA = { plan: "pro", longContextExtraUsage: true };

// Simulated pi-ai registry entry — extra fields mimic the ones pi-ai exposes
// that must not leak into the provider-registered MODELS array.
const mockPiAiModel = (id, extra = {}) => ({
	id, name: id, reasoning: true, input: ["text"], cost: { input: 1, output: 1 },
	contextWindow: 200000, maxTokens: 8000,
	// Leaky fields that should be stripped by the projection:
	baseUrl: "https://api.anthropic.com", api: "anthropic", provider: "anthropic",
	headers: { "x-api-key": "LEAK" },
	...extra,
});

const oneM = (id) => mockPiAiModel(id, { contextWindow: 1000000 });

const find = (models, id) => models.find((m) => m.id === id);

describe("MODELS projection", () => {
	it("driven by pi-ai's real anthropic catalog, minus dated snapshot aliases", () => {
		const models = buildModels(getModels("anthropic"));
		for (const m of models) {
			expect(m.id, "no dated snapshot ids in the picker").not.toMatch(/-20\d{6}$/);
			expect(m.baseUrl).toBe(undefined);
			expect(m.api).toBe(undefined);
			expect(m.provider).toBe(undefined);
			expect(m.headers).toBe(undefined);
			expect(m.cost).toStrictEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
		// Spot-check coverage of every current family.
		expect(find(models, "claude-opus-5"), "opus-5 present").toBeTruthy();
		expect(find(models, "claude-fable-5-1"), "fable-5-1 present").toBeTruthy();
		expect(find(models, "claude-haiku-4-5"), "haiku present").toBeTruthy();
	});

	it("sorts newest generation first within each family", () => {
		const models = buildModels([
			oneM("claude-opus-4-7"), oneM("claude-opus-5"),
			oneM("claude-sonnet-5"), oneM("claude-opus-4-6"),
		]);
		expect(models.map((m) => m.id)).toStrictEqual(["claude-opus-5", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5"]);
	});

	it("keeps dated aliases from stealing shortcuts from bare ids", () => {
		const models = buildModels([mockPiAiModel("claude-opus-4-5-20251101"), mockPiAiModel("claude-opus-4-5")]);
		expect(models.map((m) => m.id)).toStrictEqual(["claude-opus-4-5"]);
		expect(resolveModel(models, "opus-4-5")?.id).toBe("claude-opus-4-5");
	});

	it("sinks unknown families below the known shortcut families", () => {
		const models = buildModels([oneM("claude-proxy-x"), oneM("claude-opus-5")]);
		expect(models.map((m) => m.id)).toStrictEqual(["claude-opus-5", "claude-proxy-x"]);
	});

	it("forwards pi-ai's thinkingLevelMap verbatim", () => {
		const withMap = () => mockPiAiModel("claude-sonnet-5", { thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
		const models = buildModels([withMap()]);
		expect(find(models, "claude-sonnet-5")?.thinkingLevelMap).toStrictEqual({ xhigh: "xhigh", max: "max" });
	});

	it("forwards undefined thinkingLevelMap unchanged (no fabricated defaults)", () => {
		const models = buildModels([mockPiAiModel("claude-haiku-4-5")]);
		expect(find(models, "claude-haiku-4-5")?.thinkingLevelMap).toBe(undefined);
	});
});

describe("resolveModel", () => {
	const models = buildModels(getModels("anthropic"));

	it("opus shortcut resolves to the newest opus in the catalog", () => {
		// buildModels sorts newest-first within a family and resolveModel's partial
		// tiebreak ranks by the same version, so a new Anthropic release (pi-ai 0.87.1
		// added claude-opus-5-5) keeps both green without edits here.
		const newestOpus = models.find((m) => m.id.includes("opus"));
		expect(newestOpus, "catalog contains an opus model").toBeTruthy();
		expect(resolveModel(models, "opus")?.id).toBe(newestOpus.id);
		// Order independence: reversed input puts the oldest opus first, so a resolver
		// that settled for the first partial match would fail here.
		expect(resolveModel([...models].reverse(), "opus")?.id).toBe(newestOpus.id);
	});

	it("exact id beats newer partial match (claude-fable-5 → fable-5, not 5-1)", () => {
		expect(resolveModel(models, "claude-fable-5")?.id).toBe("claude-fable-5");
	});
});

describe("Claude Code runtime policy", () => {
	it("measured-1M ids send [1m] on every plan", () => {
		for (const id of ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5"]) {
			expect(resolveClaudeCodeRuntimeModel(oneM(id), PRO)).toStrictEqual({ cliModelId: `${id}[1m]`, contextWindow: 1000000 });
		}
	});

	it("unmeasured ids serve bare at 200K even when pi-ai declares 1M (sonnet-4-5)", () => {
		expect(resolveClaudeCodeRuntimeModel(oneM("claude-sonnet-4-5"), PRO)).toStrictEqual({ cliModelId: "claude-sonnet-4-5", contextWindow: 200000 });
	});

	it("declared 200K maps to bare id", () => {
		expect(resolveClaudeCodeRuntimeModel(mockPiAiModel("claude-haiku-4-5"), PRO)).toStrictEqual({ cliModelId: "claude-haiku-4-5", contextWindow: 200000 });
	});

	it("measured exception: opus-4-6 1M is plan-gated", () => {
		expect(resolveClaudeCodeRuntimeModel(oneM("claude-opus-4-6"), PRO)).toStrictEqual({ cliModelId: "claude-opus-4-6", contextWindow: 200000 });
		expect(resolveClaudeCodeRuntimeModel(oneM("claude-opus-4-6"), MAX)).toStrictEqual({ cliModelId: "claude-opus-4-6[1m]", contextWindow: 1000000 });
		expect(resolveClaudeCodeRuntimeModel(oneM("claude-opus-4-6"), EXTRA)).toStrictEqual({ cliModelId: "claude-opus-4-6[1m]", contextWindow: 1000000 });
	});

	it("measured exception: sonnet-4-6 1M requires extra usage", () => {
		expect(resolveClaudeCodeRuntimeModel(oneM("claude-sonnet-4-6"), PRO)).toStrictEqual({ cliModelId: "claude-sonnet-4-6", contextWindow: 200000 });
		expect(resolveClaudeCodeRuntimeModel(oneM("claude-sonnet-4-6"), EXTRA)).toStrictEqual({ cliModelId: "claude-sonnet-4-6[1m]", contextWindow: 1000000 });
	});

	it("forceTwoHundredK overrides an optimistic 1M declaration", () => {
		expect(resolveClaudeCodeRuntimeModel(oneM("claude-future-9"), { ...PRO, forceTwoHundredK: ["claude-future-9"] })).toStrictEqual({ cliModelId: "claude-future-9", contextWindow: 200000 });
	});

	it("unknown model falls back to bare id at 200K", () => {
		expect(resolveClaudeCodeRuntimeModel(mockPiAiModel("claude-future-9-9"), PRO)).toStrictEqual({ cliModelId: "claude-future-9-9", contextWindow: 200000 });
	});
});

describe("claudeCodeModelId", () => {
	it("returns the measured SDK request id", () => {
		expect(claudeCodeModelId({ id: "claude-opus-5", contextWindow: 1000000 }, PRO)).toBe("claude-opus-5[1m]");
		expect(claudeCodeModelId({ id: "claude-opus-4-7", contextWindow: 1000000 }, PRO)).toBe("claude-opus-4-7[1m]");
		expect(claudeCodeModelId({ id: "claude-haiku-4-5", contextWindow: 200000 }, PRO)).toBe("claude-haiku-4-5");
	});
});

describe("applyLongContext", () => {
	const models = buildModels(getModels("anthropic"));

	it("registers 1M for measured-1M models", () => {
		const registered = applyLongContext(models, PRO);
		expect(find(registered, "claude-opus-5").contextWindow).toBe(1000000);
		expect(find(registered, "claude-opus-4-7").contextWindow).toBe(1000000);
		expect(find(registered, "claude-fable-5-1").contextWindow).toBe(1000000);
	});

	it("registers Haiku 5.5 at 1M on every plan without changing its shortcut", () => {
		for (const settings of [PRO, MAX, EXTRA]) {
			const registered = applyLongContext(models, settings);
			const haiku = find(registered, "claude-haiku-5-5");
			expect(haiku.contextWindow).toBe(1000000);
			expect(haiku.name).toMatch(/\b1M\b/);
			expect(claudeCodeModelId(haiku, settings)).toBe("claude-haiku-5-5[1m]");
			expect(resolveModel(registered, "haiku")?.id).toBe("claude-haiku-5-5");
		}
	});
	it("allows forceTwoHundredK to override the measured Haiku 5.5 policy", () => {
		const settings = { ...PRO, forceTwoHundredK: ["claude-haiku-5-5"] };
		const haiku = find(applyLongContext(models, settings), "claude-haiku-5-5");
		expect(haiku.contextWindow).toBe(200000);
		expect(haiku.name).not.toMatch(/\b1M\b/);
		expect(claudeCodeModelId(haiku, settings)).toBe("claude-haiku-5-5");
	});

	it("leaves unmeasured sonnet-4-5 at 200K", () => {
		expect(find(applyLongContext(models, PRO), "claude-sonnet-4-5").contextWindow).toBe(200000);
	});

	it("haiku shortcut and no-match still resolve", () => {
		const newestHaiku = models.find((model) => model.id.includes("haiku"));
		expect(newestHaiku, "catalog contains a haiku model").toBeTruthy();
		expect(resolveModel(models, "haiku")?.id).toBe(newestHaiku.id);
		expect(resolveModel(models, "gpt-9")).toBe(undefined);
	});

	it("plan gates only the measured exceptions", () => {
		const pro = applyLongContext(models, PRO);
		expect(find(pro, "claude-opus-4-6").contextWindow).toBe(200000);
		expect(find(pro, "claude-sonnet-4-6").contextWindow).toBe(200000);

		const max = applyLongContext(models, MAX);
		expect(find(max, "claude-opus-4-6").contextWindow).toBe(1000000);
		expect(find(max, "claude-sonnet-4-6").contextWindow).toBe(200000);

		const extra = applyLongContext(models, EXTRA);
		expect(find(extra, "claude-opus-4-6").contextWindow).toBe(1000000);
		expect(find(extra, "claude-sonnet-4-6").contextWindow).toBe(1000000);

		// Does not mutate the source table used for id resolution.
		expect(find(models, "claude-opus-4-6").contextWindow).toBe(1000000);
	});

	it("labels exactly the registered 1M models", () => {
		const pro = applyLongContext(models, PRO);
		expect(find(pro, "claude-opus-5").name).toBe("Claude Opus 5 1M");
		expect(find(pro, "claude-opus-4-6").name).toBe("Claude Opus 4.6");
		expect(find(pro, "claude-haiku-4-5").name).toBe("Claude Haiku 4.5 (latest)");

		const extra = applyLongContext(models, EXTRA);
		expect(find(extra, "claude-sonnet-4-6").name).toBe("Claude Sonnet 4.6 1M");
	});
});

it("claude-opus-5-5 requests 1M on Pro", () => {
	expect(resolveClaudeCodeRuntimeModel({ id: "claude-opus-5-5" }, PRO)).toStrictEqual({ cliModelId: "claude-opus-5-5[1m]", contextWindow: 1000000 });
});
