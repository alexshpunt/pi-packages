import assert from "node:assert/strict";
import {
  GENERATED_CATALOG_INFO,
  GENERATED_MODELS,
  MODEL_PRICING,
  MODEL_REASONING_OPTIONS,
} from "../../src/generated/catalog.generated.ts";
import { createCatalogService } from "../../src/models/catalog-service.ts";

globalThis.fetch = async () => {
  throw new Error("Unexpected runtime network request");
};
assert.deepEqual(
  GENERATED_MODELS.map((model) => model.id),
  ["fixture-a", "fixture-b"],
);
assert.equal(MODEL_PRICING["fixture-a"].input, 1);
assert.deepEqual(MODEL_REASONING_OPTIONS["fixture-a"], [{ type: "effort", values: ["low", "high"] }]);
assert.deepEqual(GENERATED_CATALOG_INFO.nativeThinkingIds, ["fixture-a", "fixture-b"]);
const catalog = createCatalogService({
  diagnostics: {
    read: () => undefined,
    write: () => {
      throw new Error("Unexpected persistence");
    },
  },
});
const models = await catalog.refresh({
  allowNetwork: false,
  signal: new AbortController().signal,
  publish: async () => {
    throw new Error("Unexpected publication");
  },
});
const model = models.find((model) => model.id === "fixture-a");
assert.ok(model && "reasoning" in model);
assert.equal(model.thinkingLevelMap?.max, "max");
assert.equal(model.maxTokens, 32768);
assert.equal(model.cost?.input, 1);
console.log("generated runtime consumer: pass");
