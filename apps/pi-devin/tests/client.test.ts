import assert from "node:assert/strict";
import { test } from "node:test";
import { DevinClient, getModelByUID, selectModel } from "../src/core/client.ts";
import { analyticsEvent, initializeClient } from "../src/cli/initialization.ts";
import { object, type JsonObject } from "../src/core/types.ts";
import { credential, fingerprint, model, modelResponse, requestBody, STATUS_METHOD, MODELS_METHOD, statusResponse, unaryResponse } from "./helpers.ts";

for (const profile of ["agent", "standalone", "login"] as const) test(`final unary protobuf metadata profile: ${profile}`, async () => {
  const metadata: JsonObject[] = [];
  const client = new DevinClient(credential, { profile, fingerprint: fingerprint(), fetch: async (url, init) => {
    const method = new URL(String(url)).pathname.slice(1);
    const body = requestBody(method, init!);
    const headers = new Headers(init!.headers);
    assert.equal(headers.get("content-type"), "application/proto");
    assert.equal(headers.get("accept-encoding"), "gzip");
    assert.equal(headers.get("sentry-trace"), null);
    assert.equal(headers.get("authorization"), `Basic ${credential.sessionToken}-${credential.sessionToken}`);
    assert.equal(Number(headers.get("content-length")), Buffer.byteLength(init!.body as Uint8Array));
    metadata.push(object(body.metadata, "metadata"));
    return unaryResponse(method, method === MODELS_METHOD ? modelResponse() : statusResponse());
  } });
  await client.status();
  const models = await client.models();
  for (const value of metadata) {
    assert.equal(value.ideName, profile === "agent" ? "devin-cli" : "chisel");
    assert.equal(value.ideVersion, profile === "standalone" ? "0.0.0-dev" : "3000.11.92");
    assert.equal(value.extensionVersion, value.ideVersion);
    assert.equal(value.ideType, profile === "agent" ? "chisel" : undefined);
    assert.equal(value.os, process.platform);
    assert.equal(value.locale, "en");
  }
  assert.notEqual(metadata[0].f, metadata[1].f);
  assert.equal(metadata[0].supportedModelDisplays, undefined);
  assert.deepEqual(metadata[1].supportedModelDisplays, ["DISPLAY_OPTION_MODEL_ROUTER", "DISPLAY_OPTION_QUICK_REVIEW", "DISPLAY_OPTION_HIDDEN_TOOL", "DISPLAY_OPTION_WIRE_7", "DISPLAY_OPTION_MODERN_AGENT_CHAT"]);
  assert.equal(selectModel(models, "fixture-alias").id, model.id);
  assert.equal(client.defaultModelUid, model.id);
});

test("a native family or alias picks the first active variant, not the default display", () => {
  const high = { ...model, id: "swe-2-high", name: "SWE-2 High", isDefaultInFamily: true };
  assert.equal(selectModel([model, high], "swe-2").id, model.id);
  assert.equal(selectModel([high, model], "swe-2").id, high.id);
  assert.equal(selectModel([high, model], "fixture alias").id, high.id);
  assert.throws(() => selectModel([model], "   "), /empty/);
  assert.throws(() => selectModel([model], "fixture_alias"), /Model unavailable/);
});

test("precedence of family, alias, exact UID and display name, and resolved UID lookup", () => {
  const shadow = { ...model, id: "shadow-model", name: "Shadow", familyId: "shadow", aliases: [model.id, "swe-2"] };
  assert.equal(selectModel([shadow, model], "swe-2").id, model.id);
  assert.equal(selectModel([shadow, model], model.id).id, shadow.id);
  assert.equal(getModelByUID([shadow, model], model.id).id, model.id);
  assert.throws(() => getModelByUID([model], "SWE2MEDIUM"), /not replaced/);
  const label = { ...model, id: "label-uid", name: "Precise Label", familyId: "label-family", aliases: [] };
  assert.equal(selectModel([shadow, label], "Precise Label").id, label.id);
  assert.throws(() => selectModel([label], "Precise"), /Model unavailable/);
});

test("partial names require whole alphanumeric tokens in any order", () => {
  const high = { ...model, id: "swe-2-high", name: "SWE-2 High" };
  const gpt = { ...model, id: "gpt-5-4-high", name: "GPT-5.4 High Thinking", familyId: "gpt-5.4", aliases: [] };
  for (const selector of ["SWE2MEDIUM", "swe_2_medium", "medium swe", "SWE 2 MEDIUM"]) {
    assert.equal(selectModel([high, model, gpt], selector).id, model.id);
  }
  assert.equal(selectModel([gpt, high, model], "high gpt").id, gpt.id);
  for (const selector of ["SWE 2 MED", "swe2med", "med", "ium", "2", "gpt54", "gpt99", "thinking"]) {
    assert.throws(() => selectModel([model, high, gpt], selector), /Model unavailable/);
  }
});

test("for partial names, the extra token count and descending UID order win over catalog order", () => {
  const collision = { ...model, id: "swe_2_medium" };
  const longer = { ...model, id: "swe-2-medium-zebra", name: "SWE-2 Medium Zebra" };
  for (const catalog of [[model, collision, longer], [longer, collision, model]]) {
    assert.equal(selectModel(catalog, "SWE2MEDIUM").id, collision.id);
    assert.equal(selectModel(catalog, model.id).id, model.id);
  }
  const first = { ...model, id: "a-shared", familyId: "a-family", aliases: [] };
  const second = { ...model, id: "b-shared", familyId: "b-family", aliases: [] };
  for (const catalog of [[first, second], [second, first]]) assert.equal(selectModel(catalog, "shared").id, second.id);
});

test("an alias of a disabled variant maps to the active family but is not bypassed when everything is disabled", () => {
  const disabled = { ...model, aliases: ["rare"], isDisabled: true };
  const high = { ...model, id: "swe-2-high", aliases: [] };
  const partial = { ...model, id: "rare-larger-model", familyId: "another-family", aliases: [] };
  assert.equal(selectModel([disabled, high], "rare").id, high.id);
  assert.throws(() => selectModel([disabled, partial], "rare"), /disabled/);
  assert.throws(() => selectModel([disabled, high], model.id), /disabled/);
  assert.throws(() => selectModel([model, partial], "no-such-selector"), /Model unavailable/);
});

test("initialization team, plugin and REST lookups and the final Bearer/header application", async () => {
  const paths: string[] = [];
  const local = { ...credential, apiServerURL: "http://127.0.0.1:9999" };
  const client = new DevinClient(local, { fingerprint: fingerprint(), fetch: async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, local.apiServerURL);
    paths.push(parsed.pathname);
    if (parsed.pathname.startsWith("/v3/")) {
      const headers = new Headers(init?.headers);
      assert.equal(init?.method, "GET");
      assert.equal(headers.get("authorization"), `Bearer ${credential.sessionToken}`);
      assert.equal(headers.get("sentry-trace"), null);
      assert.equal(headers.get("content-type"), null);
      assert.equal(headers.get("accept-encoding"), parsed.pathname === "/v3/self" ? null : "gzip");
      return Response.json({});
    }
    const method = parsed.pathname.slice(1);
    const request = requestBody(method, init!);
    if (method.endsWith("/GetCliTeamSettings")) assert.equal((object(request.metadata, "metadata").supportedModelDisplays as string[]).length, 5);
    return unaryResponse(method, method === STATUS_METHOD ? statusResponse(local.apiServerURL) : method === MODELS_METHOD ? modelResponse() : {});
  } });
  const result = await initializeClient(client);
  assert.equal(result.models[0].id, model.id);
  assert.equal(paths.length, 6);
  assert.ok(paths.includes("/exa.api_server_pb.ApiServerService/GetAccountManagedPlugins"));
  assert.ok(paths.includes("/v3/organizations/offline-org/integrations"));
  assert.ok(client.accountIdentityHash);
});

test("analytics event path, API key, device hash and map keys reach the final protobuf", async () => {
  const method = "exa.product_analytics_pb.ProductAnalyticsService/BatchRecordAnalyticsEvents";
  let calls = 0;
  const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).pathname, `/${method}`);
    const body = requestBody(method, init!);
    assert.equal(body.apiKey, credential.sessionToken);
    const events = body.events as JsonObject[];
    assert.equal(events[0].eventName, "SESSION_CREATED");
    assert.equal(events[0].deviceFingerprint, client.fingerprint.device());
    assert.equal(events[0].ideName, "chisel");
    assert.equal(object(events[0].extra, "extra").headless, "true");
    assert.equal(object(events[0].extra, "extra").model_name, model.id);
    assert.equal(events[1].ideName, "devin-cli");
    assert.equal(events[1].ideType, "chisel");
    assert.equal(events[1].installationId, undefined);
    assert.equal(object(events[1].extra, "extra").tool_name, "add");
    assert.equal(new Headers(init?.headers).get("sentry-trace"), null);
    return unaryResponse(method, {});
  } });
  const options = { installationId: "00000000-0000-4000-8000-000000000000", model: model.id };
  await client.analytics([analyticsEvent(client, "SESSION_CREATED", options), analyticsEvent(client, "AGENT_TOOL_CALLED", { ...options, toolName: "add" })]);
  assert.equal(calls, 1);
});

test("follow-up calls stop when the account, quota or REST destination is not verified", async () => {
  for (const failure of ["owner", "quota", "endpoint", "permission"]) {
    let calls = 0;
    const client = new DevinClient(credential, { fingerprint: fingerprint(), fetch: async () => {
      calls++;
      const body = statusResponse(failure === "endpoint" ? "https://unexpected.invalid" : undefined);
      const plan = object(object(body.userStatus, "user").planStatus, "plan");
      if (failure === "quota") plan.dailyQuotaRemainingPercent = 0;
      if (failure === "permission") object(object(plan.planInfo, "info").devinInfo, "devin").canUseCli = false;
      return unaryResponse(STATUS_METHOD, body);
    } });
    await assert.rejects(initializeClient(client, { expectedOwnerHash: failure === "owner" ? "different" : undefined }));
    assert.equal(calls, 1);
  }
});
