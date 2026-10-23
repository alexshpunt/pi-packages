import { Effect } from "effect";
import { expect, test } from "vitest";
import { analyticsEvent, initializeClient } from "../src/cli/initialization.ts";
import { getModelByUID, selectModel } from "../src/core/client.ts";
import { NodePlatformLayer } from "../src/core/services/platform.ts";
import type { JsonObject, ModelInfo } from "../src/core/types.ts";
import { object as objectEffect } from "../src/core/validation.ts";
import { credential, devinClient, fingerprint, model, modelResponse, requestBody, run, runSync, STATUS_METHOD, MODELS_METHOD, statusResponse, unaryResponse } from "./helpers.ts";

const object = (value: unknown, label: string) => runSync(objectEffect(value, label));
const select = (models: readonly ModelInfo[], selector: string) => runSync(selectModel(models, selector));

for (const profile of ["agent", "standalone", "login"] as const) test(`final unary protobuf metadata profile: ${profile}`, async () => {
  const metadata: JsonObject[] = [];
  const client = devinClient(credential, { profile, fingerprint: fingerprint(), fetch: async (url, init) => {
    const method = new URL(String(url)).pathname.slice(1);
    const body = requestBody(method, init!);
    const headers = new Headers(init!.headers);
    expect(headers.get("content-type")).toBe("application/proto");
    expect(headers.get("accept-encoding")).toBe("gzip");
    expect(headers.get("sentry-trace")).toBe(null);
    expect(headers.get("authorization")).toBe(`Basic ${credential.sessionToken}-${credential.sessionToken}`);
    expect(Number(headers.get("content-length"))).toBe(Buffer.byteLength(init!.body as Uint8Array));
    metadata.push(object(body.metadata, "metadata"));
    return unaryResponse(method, method === MODELS_METHOD ? modelResponse() : statusResponse());
  } });
  await run(client.status());
  const models = await run(client.models);
  for (const value of metadata) {
    expect(value.ideName).toBe(profile === "agent" ? "devin-cli" : "chisel");
    expect(value.ideVersion).toBe(profile === "standalone" ? "0.0.0-dev" : "3000.11.92");
    expect(value.extensionVersion).toBe(value.ideVersion);
    expect(value.ideType).toBe(profile === "agent" ? "chisel" : undefined);
    expect(value.os).toBe(process.platform);
    expect(value.locale).toBe("en");
  }
  expect(metadata[0].f).not.toBe(metadata[1].f);
  expect(metadata[0].supportedModelDisplays).toBe(undefined);
  expect(metadata[1].supportedModelDisplays).toStrictEqual(["DISPLAY_OPTION_MODEL_ROUTER", "DISPLAY_OPTION_QUICK_REVIEW", "DISPLAY_OPTION_HIDDEN_TOOL", "DISPLAY_OPTION_WIRE_7", "DISPLAY_OPTION_MODERN_AGENT_CHAT"]);
  expect(select(models, "fixture-alias").id).toBe(model.id);
  expect(runSync(client.defaultModelUid)).toBe(model.id);
});

test("a native family or alias picks the first active variant, not the default display", () => {
  const high = { ...model, id: "swe-2-high", name: "SWE-2 High", isDefaultInFamily: true };
  expect(select([model, high], "swe-2").id).toBe(model.id);
  expect(select([high, model], "swe-2").id).toBe(high.id);
  expect(select([high, model], "fixture alias").id).toBe(high.id);
  expect(() => select([model], "   ")).toThrow(/empty/);
  expect(() => select([model], "fixture_alias")).toThrow(/Model unavailable/);
});

test("precedence of family, alias, exact UID and display name, and resolved UID lookup", () => {
  const shadow = { ...model, id: "shadow-model", name: "Shadow", familyId: "shadow", aliases: [model.id, "swe-2"] };
  expect(select([shadow, model], "swe-2").id).toBe(model.id);
  expect(select([shadow, model], model.id).id).toBe(shadow.id);
  expect(runSync(getModelByUID([shadow, model], model.id)).id).toBe(model.id);
  expect(() => runSync(getModelByUID([model], "SWE2MEDIUM"))).toThrow(/not replaced/);
  const label = { ...model, id: "label-uid", name: "Precise Label", familyId: "label-family", aliases: [] };
  expect(select([shadow, label], "Precise Label").id).toBe(label.id);
  expect(() => select([label], "Precise")).toThrow(/Model unavailable/);
});

test("partial names require whole alphanumeric tokens in any order", () => {
  const high = { ...model, id: "swe-2-high", name: "SWE-2 High" };
  const gpt = { ...model, id: "gpt-5-4-high", name: "GPT-5.4 High Thinking", familyId: "gpt-5.4", aliases: [] };
  for (const selector of ["SWE2MEDIUM", "swe_2_medium", "medium swe", "SWE 2 MEDIUM"]) {
    expect(select([high, model, gpt], selector).id).toBe(model.id);
  }
  expect(select([gpt, high, model], "high gpt").id).toBe(gpt.id);
  for (const selector of ["SWE 2 MED", "swe2med", "med", "ium", "2", "gpt54", "gpt99", "thinking"]) {
    expect(() => select([model, high, gpt], selector)).toThrow(/Model unavailable/);
  }
});

test("for partial names, the extra token count and descending UID order win over catalog order", () => {
  const collision = { ...model, id: "swe_2_medium" };
  const longer = { ...model, id: "swe-2-medium-zebra", name: "SWE-2 Medium Zebra" };
  for (const catalog of [[model, collision, longer], [longer, collision, model]]) {
    expect(select(catalog, "SWE2MEDIUM").id).toBe(collision.id);
    expect(select(catalog, model.id).id).toBe(model.id);
  }
  const first = { ...model, id: "a-shared", familyId: "a-family", aliases: [] };
  const second = { ...model, id: "b-shared", familyId: "b-family", aliases: [] };
  for (const catalog of [[first, second], [second, first]]) expect(select(catalog, "shared").id).toBe(second.id);
});

test("an alias of a disabled variant maps to the active family but is not bypassed when everything is disabled", () => {
  const disabled = { ...model, aliases: ["rare"], isDisabled: true };
  const high = { ...model, id: "swe-2-high", aliases: [] };
  const partial = { ...model, id: "rare-larger-model", familyId: "another-family", aliases: [] };
  expect(select([disabled, high], "rare").id).toBe(high.id);
  expect(() => select([disabled, partial], "rare")).toThrow(/disabled/);
  expect(() => select([disabled, high], model.id)).toThrow(/disabled/);
  expect(() => select([model, partial], "no-such-selector")).toThrow(/Model unavailable/);
});

test("initialization team, plugin and REST lookups and the final Bearer/header application", async () => {
  const paths: string[] = [];
  const local = { ...credential, apiServerURL: "http://127.0.0.1:9999" };
  const client = devinClient(local, { fingerprint: fingerprint(), fetch: async (url, init) => {
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe(local.apiServerURL);
    paths.push(parsed.pathname);
    if (parsed.pathname.startsWith("/v3/")) {
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("GET");
      expect(headers.get("authorization")).toBe(`Bearer ${credential.sessionToken}`);
      expect(headers.get("sentry-trace")).toBe(null);
      expect(headers.get("content-type")).toBe(null);
      expect(headers.get("accept-encoding")).toBe(parsed.pathname === "/v3/self" ? null : "gzip");
      return Response.json({});
    }
    const method = parsed.pathname.slice(1);
    const request = requestBody(method, init!);
    if (method.endsWith("/GetCliTeamSettings")) expect((object(request.metadata, "metadata").supportedModelDisplays as string[]).length).toBe(5);
    return unaryResponse(method, method === STATUS_METHOD ? statusResponse(local.apiServerURL) : method === MODELS_METHOD ? modelResponse() : {});
  } });
  const result = await run(initializeClient(client));
  expect(result.models[0].id).toBe(model.id);
  expect(paths.length).toBe(6);
  expect(paths.includes("/exa.api_server_pb.ApiServerService/GetAccountManagedPlugins")).toBeTruthy();
  expect(paths.includes("/v3/organizations/offline-org/integrations")).toBeTruthy();
  expect(runSync(client.accountIdentityHash)).toBeTruthy();
});

test("analytics event path, API key, device hash and map keys reach the final protobuf", async () => {
  const method = "exa.product_analytics_pb.ProductAnalyticsService/BatchRecordAnalyticsEvents";
  let calls = 0;
  const client = devinClient(credential, { fingerprint: fingerprint(), fetch: async (url, init) => {
    calls++;
    expect(new URL(String(url)).pathname).toBe(`/${method}`);
    const body = requestBody(method, init!);
    expect(body.apiKey).toBe(credential.sessionToken);
    const events = body.events as JsonObject[];
    expect(events[0].eventName).toBe("SESSION_CREATED");
    expect(events[0].deviceFingerprint).toBe(runSync(client.fingerprint.device));
    expect(events[0].ideName).toBe("chisel");
    expect(object(events[0].extra, "extra").headless).toBe("true");
    expect(object(events[0].extra, "extra").model_name).toBe(model.id);
    expect(events[1].ideName).toBe("devin-cli");
    expect(events[1].ideType).toBe("chisel");
    expect(events[1].installationId).toBe(undefined);
    expect(object(events[1].extra, "extra").tool_name).toBe("add");
    expect(new Headers(init?.headers).get("sentry-trace")).toBe(null);
    return unaryResponse(method, {});
  } });
  const options = { installationId: "00000000-0000-4000-8000-000000000000", model: model.id };
  const events = await run(Effect.all([analyticsEvent(client, "SESSION_CREATED", options), analyticsEvent(client, "AGENT_TOOL_CALLED", { ...options, toolName: "add" })]).pipe(Effect.provide(NodePlatformLayer)));
  await run(client.analytics(events));
  expect(calls).toBe(1);
});

test("follow-up calls stop when the account, quota or REST destination is not verified", async () => {
  for (const failure of ["owner", "quota", "endpoint", "permission"]) {
    let calls = 0;
    const client = devinClient(credential, { fingerprint: fingerprint(), fetch: async () => {
      calls++;
      const body = statusResponse(failure === "endpoint" ? "https://unexpected.invalid" : undefined);
      const plan = object(object(body.userStatus, "user").planStatus, "plan");
      if (failure === "quota") plan.dailyQuotaRemainingPercent = 0;
      if (failure === "permission") object(object(plan.planInfo, "info").devinInfo, "devin").canUseCli = false;
      return unaryResponse(STATUS_METHOD, body);
    } });
    await expect(run(initializeClient(client, { expectedOwnerHash: failure === "owner" ? "different" : undefined }))).rejects.toThrow();
    expect(calls).toBe(1);
  }
});
