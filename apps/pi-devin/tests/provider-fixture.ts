import { readFile } from "node:fs/promises";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { createDevinProvider } from "../src/pi/provider.ts";
import { createFingerprintProvider } from "../src/core/protocol/fingerprint.ts";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import type { Credential, JsonObject } from "../src/core/types.ts";
import { finalFrames, identity, MODELS_METHOD, requestBody, STATUS_METHOD, statusResponse, streamResponse, unaryResponse } from "./helpers.ts";

export const TEAM_METHOD = "exa.seat_management_pb.SeatManagementService/GetCliTeamSettings";
export const providerCredential: Credential = { version: 1, sessionToken: "mock-pi-provider-token", apiServerURL: "https://example.invalid", createdAt: "2026-01-01T00:00:00.000Z" };
export const providerHostCredential = { type: "oauth" as const, access: providerCredential.sessionToken, refresh: "", expires: 0,
  devin: { version: 1, apiServerURL: providerCredential.apiServerURL, createdAt: providerCredential.createdAt } };
const allModels = JSON.parse(await readFile(new URL("./fixtures/model-catalog.json", import.meta.url), "utf8"));
export const providerCatalog: JsonObject = { clientModelConfigs: allModels.clientModelConfigs.filter((config: JsonObject) => ["swe-2-medium", "swe-2-high", "swe-2-max"].includes(config.modelUid as string)) };
/** De-identified model group that the catalog marks with Prompt Cache Retention=24h. */
export const extendedCacheCatalog: JsonObject = { clientModelConfigs: allModels.clientModelConfigs.filter((config: JsonObject) => /^gpt-5-6-sol-(none|low|medium|high|xhigh|max)$/.test(config.modelUid as string)) };
export interface CapturedProviderRequest { method: string; body: JsonObject; headers: Headers; signal: AbortSignal; init: RequestInit }

export async function providerFixture(options: {
  chat?: (request: CapturedProviderRequest, index: number) => Response | Promise<Response>;
  status?: JsonObject;
  maxModelCalls?: number;
  catalog?: JsonObject;
} = {}) {
  const requests: CapturedProviderRequest[] = [];
  let chatCalls = 0, fingerprintCollections = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const method = new URL(String(url)).pathname.slice(1);
    const captured = { method, body: requestBody(method, init!), headers: new Headers(init!.headers), signal: init!.signal!, init: init! };
    requests.push(captured);
    if (method.endsWith("/ExchangeDevinCLIPKCECode")) return unaryResponse(method, { sessionToken: providerCredential.sessionToken });
    if (method.endsWith("/ExchangePKCEAuthorizationCode")) return unaryResponse(method, { apiKey: providerCredential.sessionToken, apiServerUrl: providerCredential.apiServerURL });
    if (method === STATUS_METHOD) return unaryResponse(method, options.status ?? statusResponse());
    if (method === MODELS_METHOD) return unaryResponse(method, options.catalog ?? providerCatalog);
    if (method === TEAM_METHOD) return unaryResponse(method, {});
    if (method !== CHAT_METHOD) throw new Error("Unexpected fixture RPC: " + method);
    chatCalls++;
    return options.chat?.(captured, chatCalls) ?? streamResponse(finalFrames());
  };
  const dependencies = { fetch: fetchImpl, maxModelCalls: options.maxModelCalls,
    loginOptions: { apiServerURL: providerCredential.apiServerURL, webappURL: "https://example.invalid" },
    fingerprint: (credential: Credential) => createFingerprintProvider(credential.sessionToken, { collectIdentity: () => { fingerprintCollections++; return identity; } }),
  };
  const provider = createDevinProvider(dependencies);
  if (requests.length || fingerprintCollections) throw new Error("Factory must not perform I/O");
  const refresh: RefreshModelsContext = { credential: providerHostCredential, allowNetwork: true, force: true, signal: new AbortController().signal,
    publish: async (value) => { value.update?.(); return true; },
  };
  await provider.refreshModels(refresh);
  // Family models have several thinking levels. Fusion mirrors its lead family, so it is skipped.
  const model = provider.getModels().find((model) => model.id !== "fusion" && Object.values(model.thinkingLevelMap ?? {}).filter(Boolean).length > 1)!;
  if (!model) throw new Error("Fixture group missing");
  return { provider, model, dependencies, requests, chatCalls: () => chatCalls, fingerprintCollections: () => fingerprintCollections };
}
