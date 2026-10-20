import { gunzipSync } from "node:zlib";
import { createFingerprintProvider } from "../src/core/protocol/fingerprint.ts";
import { CHAT_METHOD, chatRequestCodec, chatResponseCodec, unaryCodecs } from "../src/core/protocol/protobuf.ts";
import { encodeFrame } from "../src/core/protocol/transport.ts";
import type { Credential, JsonObject, ModelInfo } from "../src/core/types.ts";

export const STATUS_METHOD = "exa.seat_management_pb.SeatManagementService/GetUserStatus";
export const MODELS_METHOD = "exa.api_server_pb.ApiServerService/GetCliModelConfigs";
export const credential: Credential = {
  version: 1, sessionToken: "mock-offline-token", apiServerURL: "https://example.invalid", createdAt: "2026-01-01T00:00:00.000Z",
};
export const identity = { serial: "OFFLINE-SERIAL", macs: [], username: "offline-user" };
export const fingerprint = () => createFingerprintProvider(credential.sessionToken, { collectIdentity: () => identity });
export const model: ModelInfo = {
  id: "swe-2-medium", name: "SWE-2 Medium", contextWindow: 131072, maxOutputTokens: 128000,
  supportsThinking: true, supportsImages: true, supportsToolCalls: true, supportsParallelToolCalls: true,
  isRouter: false, isDisabled: false, familyId: "swe-2", aliases: ["fixture-alias"],
};

export function streamResponse(frames: JsonObject[]): Response {
  return new Response(new Uint8Array(Buffer.concat([
    ...frames.map((frame) => encodeFrame(chatResponseCodec.encode(frame))), encodeFrame(Buffer.from("{}"), 2),
  ])), { headers: { "content-type": "application/connect+proto" } });
}
export function errorStreamResponse(code: string, message: string, frames: JsonObject[] = []): Response {
  return new Response(new Uint8Array(Buffer.concat([
    ...frames.map((frame) => encodeFrame(chatResponseCodec.encode(frame))),
    encodeFrame(Buffer.from(JSON.stringify({ error: { code, message } })), 2),
  ])), { headers: { "content-type": "application/connect+proto" } });
}

export function finalFrames(text = "OK"): JsonObject[] {
  return [{ messageId: "bot-response", deltaText: text }, { stopReason: "STOP_REASON_STOP_PATTERN" }, { usage: { inputTokens: 3, outputTokens: 2 } }];
}
export function unaryResponse(method: string, body: JsonObject): Response {
  return new Response(new Uint8Array(unaryCodecs(method).response.encode(body)), { headers: { "content-type": "application/proto" } });
}
export function requestBody(method: string, init: RequestInit): JsonObject {
  const bytes = Buffer.from(init.body as Uint8Array);
  return method === CHAT_METHOD ? chatRequestCodec.decode(bytes[0] & 1 ? gunzipSync(bytes.subarray(5)) : bytes.subarray(5))
    : unaryCodecs(method).request.decode(bytes);
}
export function modelResponse(): JsonObject {
  return {
    clientModelConfigs: [{ modelUid: model.id, label: model.name, supportsImages: true,
      modelInfo: { modelUid: model.id, modelFamilyUid: model.familyId, aliases: model.aliases,
        maxTokens: model.contextWindow, maxOutputTokens: model.maxOutputTokens,
        modelFeatures: { supportsImages: true, supportsToolCalls: true, supportsParallelToolCalls: true, supportsThinking: true } } }],
    defaultOverrideModelConfig: { modelUid: model.id },
  };
}
export function statusResponse(restBaseURL?: string): JsonObject {
  return { userStatus: { userId: "offline-user-id", planStatus: {
    planInfo: { billingStrategy: "BILLING_STRATEGY_QUOTA", devinInfo: { canUseCli: true, orgId: "offline-org", ...(restBaseURL ? { apiUrl: restBaseURL } : {}) } },
    dailyQuotaRemainingPercent: 100, weeklyQuotaRemainingPercent: 100,
  } } };
}
