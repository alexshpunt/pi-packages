import { expect, test } from "vitest";
import { CORE_CONTRACT_VERSION, DevinClient, ChatAccumulator, getModelByUID } from "../src/core/index.ts";
import { chatResponseCodec } from "../src/core/protocol/protobuf.ts";
import { object, type JsonObject } from "../src/core/types.ts";
import { credential, fingerprint, model, modelResponse, MODELS_METHOD, unaryResponse } from "./helpers.ts";

test("the shared API raw catalog and the CLI model projection use the same lookup", async () => {
  expect(CORE_CONTRACT_VERSION).toBe(1);
  let calls = 0;
  const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async (url) => {
    calls++; expect(new URL(String(url)).pathname).toBe("/" + MODELS_METHOD);
    return unaryResponse(MODELS_METHOD, modelResponse());
  } });
  try {
    const catalog = await client.catalog();
    expect(calls).toBe(1);
    expect(catalog.defaultModelUid).toBe(model.id);
    expect(client.defaultModelUid).toBe(model.id);
    expect(getModelByUID(catalog.models, model.id).supportsThinking).toBe(true);
    const raw = (catalog.raw.clientModelConfigs as JsonObject[])[0];
    expect(object(raw.modelInfo, "modelInfo").modelFamilyUid).toBe(model.familyId);
    expect(await client.models()).toStrictEqual(catalog.models);
    expect(calls).toBe(2);
    await expect(client.catalog(AbortSignal.abort(new DOMException("cancel", "AbortError")))).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    expect(calls).toBe(2);
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
  expect(JSON.parse(acc.finish().message.toolCalls![0].argumentsJson)).toStrictEqual({ value: 42 });
});
