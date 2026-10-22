import { expect, test } from "vitest";
import { CORE_CONTRACT_VERSION, ChatAccumulator, getModelByUID } from "../src/core/index.ts";
import { chatResponseCodec } from "../src/core/protocol/protobuf.ts";
import type { JsonObject } from "../src/core/types.ts";
import { object } from "../src/core/validation.ts";
import { close, credential, devinClient, fingerprint, model, modelResponse, MODELS_METHOD, run, runSync, unaryResponse } from "./helpers.ts";

test("the shared API raw catalog and the CLI model projection use the same lookup", async () => {
  expect(CORE_CONTRACT_VERSION).toBe(3);
  let calls = 0;
  const client = devinClient(credential, { fingerprint: fingerprint(), fetch: async (url) => {
    calls++; expect(new URL(String(url)).pathname).toBe("/" + MODELS_METHOD);
    return unaryResponse(MODELS_METHOD, modelResponse());
  } });
  try {
    const catalog = await run(client.catalog);
    expect(calls).toBe(1);
    expect(catalog.defaultModelUid).toBe(model.id);
    expect(runSync(client.defaultModelUid)).toBe(model.id);
    expect(runSync(getModelByUID(catalog.models, model.id)).supportsThinking).toBe(true);
    const raw = (catalog.raw.clientModelConfigs as JsonObject[])[0];
    expect(runSync(object(raw.modelInfo, "modelInfo")).modelFamilyUid).toBe(model.familyId);
    expect(await run(client.models)).toStrictEqual(catalog.models);
    expect(calls).toBe(2);
    await expect(run(client.catalog, AbortSignal.abort(new DOMException("cancel", "AbortError")))).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    expect(calls).toBe(2);
  } finally { close(client); }
});

test("JSON argument fragments recorded as numbers are converted to protobuf strings and joined", () => {
  const acc = new ChatAccumulator();
  const frames: JsonObject[] = [
    { deltaToolCalls: [{ id: "fixture", name: "fixture_tool", argumentsJson: '{"value":' }] },
    { deltaToolCalls: [{ argumentsJson: 42 }] },
    { deltaToolCalls: [{ argumentsJson: "}" }], stopReason: "STOP_REASON_FUNCTION_CALL" },
  ];
  for (const frame of frames) runSync(acc.accept(runSync(chatResponseCodec.decode(runSync(chatResponseCodec.encode(frame))))));
  runSync(acc.accept({}, true));
  expect(JSON.parse(runSync(acc.finish).message.toolCalls![0].argumentsJson)).toStrictEqual({ value: 42 });
});
