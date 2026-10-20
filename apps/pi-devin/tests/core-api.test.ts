import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_CONTRACT_VERSION, DevinClient, ChatAccumulator, getModelByUID } from "../src/core/index.ts";
import { chatResponseCodec } from "../src/core/protocol/protobuf.ts";
import { object, type JsonObject } from "../src/core/types.ts";
import { credential, fingerprint, model, modelResponse, MODELS_METHOD, unaryResponse } from "./helpers.ts";

test("the shared API raw catalog and the CLI model projection use the same lookup", async () => {
  assert.equal(CORE_CONTRACT_VERSION, 1);
  let calls = 0;
  const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async (url) => {
    calls++; assert.equal(new URL(String(url)).pathname, "/" + MODELS_METHOD);
    return unaryResponse(MODELS_METHOD, modelResponse());
  } });
  try {
    const catalog = await client.catalog();
    assert.equal(calls, 1);
    assert.equal(catalog.defaultModelUid, model.id);
    assert.equal(client.defaultModelUid, model.id);
    assert.equal(getModelByUID(catalog.models, model.id).supportsThinking, true);
    const raw = (catalog.raw.clientModelConfigs as JsonObject[])[0];
    assert.equal(object(raw.modelInfo, "modelInfo").modelFamilyUid, model.familyId);
    assert.deepEqual(await client.models(), catalog.models);
    assert.equal(calls, 2);
    await assert.rejects(client.catalog(AbortSignal.abort(new DOMException("cancel", "AbortError"))), { name: "AbortError" });
    assert.equal(calls, 2);
  } finally { client.transport.close(); }
});

test("JSON argument fragments recorded as numbers are converted to protobuf strings and joined", () => {
  const acc = new ChatAccumulator();
  const frames: JsonObject[] = [
    { deltaToolCalls: [{ id: "fixture", name: "fixture_tool", argumentsJson: '{"value":' }] },
    { deltaToolCalls: [{ argumentsJson: 42 }] },
    { deltaToolCalls: [{ argumentsJson: "}" }], stopReason: "STOP_REASON_FUNCTION_CALL" },
  ];
  for (const frame of frames) acc.accept(chatResponseCodec.decode(chatResponseCodec.encode(frame)));
  acc.accept({}, true);
  assert.deepEqual(JSON.parse(acc.finish().message.toolCalls![0].argumentsJson), { value: 42 });
});
