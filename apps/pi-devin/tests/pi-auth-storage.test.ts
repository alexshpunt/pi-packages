import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore, InMemoryModelsStore, type Api, type Credential as HostCredential, type Model, type Provider, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createDevinAccountAuth, OAUTH_ONLY_MESSAGE } from "../src/pi/auth.ts";
import { createDevinProvider } from "../src/pi/provider.ts";
import { DevinClient } from "../src/core/client.ts";
import { createFingerprintProvider } from "../src/core/protocol/fingerprint.ts";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import type { JsonObject } from "../src/core/types.ts";
import { identity, STATUS_METHOD, statusResponse, unaryResponse } from "./helpers.ts";
import { providerCredential, providerFixture } from "./provider-fixture.ts";

test("OAuth only: Pi API key resolution paths are rejected without a Devin request and only the OAuth session uses models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-oauth-only-"));
  const fixture = await providerFixture();
  fixture.provider.shutdown();
  const serviceKey = "cog_fake-service-key", windsurfKey = "sk-ws-01-fake-key";
  const previous = { DEVIN_API_KEY: process.env.DEVIN_API_KEY, WINDSURF_API_KEY: process.env.WINDSURF_API_KEY };
  process.env.DEVIN_API_KEY = serviceKey; process.env.WINDSURF_API_KEY = windsurfKey;
  const providers: Provider[] = [];
  let configIndex = 0;
  async function host(options: { models?: JsonObject; stored?: HostCredential } = {}) {
    const credentials = new InMemoryCredentialStore();
    if (options.stored) await credentials.modify("devin", async () => options.stored);
    const modelsPath = join(directory, `models-${configIndex++}.json`);
    if (options.models) await writeFile(modelsPath, JSON.stringify(options.models));
    const runtime = await ModelRuntime.create({ credentials, modelsPath, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
    const provider = createDevinProvider(fixture.dependencies);
    providers.push(provider);
    runtime.registerNativeProvider(provider);
    return runtime;
  }
  async function attempt(runtime: ModelRuntime, options: SimpleStreamOptions = {}, model: Model<Api> = fixture.model) {
    const before = fixture.requests.length;
    const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { reasoning: "medium", ...options })
      .catch((error: Error) => ({ stopReason: "thrown", errorMessage: error.message }));
    assert.equal(JSON.stringify(result).includes(serviceKey) || JSON.stringify(result).includes(windsurfKey), false);
    return { stopReason: result.stopReason, errorMessage: result.errorMessage ?? "", requests: fixture.requests.slice(before) };
  }
  try {
    // Devin registers no API key method, so Pi does not resolve `--api-key`, a stored api_key or environment variables.
    const runtimeKey = await host();
    await runtimeKey.setRuntimeApiKey("devin", serviceKey);
    const storedKey = await host({ stored: { type: "api_key", key: serviceKey } });
    const environmentOnly = await host();
    for (const runtime of [runtimeKey, storedKey, environmentOnly]) {
      assert.equal(runtime.getProvider("devin")!.auth.apiKey, undefined);
      const result = await attempt(runtime);
      assert.match(result.errorMessage, /not configured/);
      assert.deepEqual(result.requests, []);
    }
    // An apiKey in models.json makes the host synthesize an API key method. Without OAuth there are no Devin models,
    // so Pi 1.3.0 stops with an unregistered API error instead of reaching the provider; no Devin request is sent either way.
    const configuredKey = await host({ models: { providers: { devin: { apiKey: "$DEVIN_API_KEY" } } } });
    assert.ok(configuredKey.getProvider("devin")!.auth.apiKey);
    assert.deepEqual(configuredKey.getModels("devin"), []);
    const configured = await attempt(configuredKey);
    assert.match(configured.errorMessage, /No API provider registered for api: devin-connect/);
    assert.deepEqual(configured.requests, []);
    // Even with OAuth, the provider rejects a different key overridden by the caller, while the OAuth-resolved session keeps using models.
    // The stored OAuth wins even when models.json has an apiKey in the same runtime.
    const oauth = await host({ models: { providers: { devin: { apiKey: "$WINDSURF_API_KEY" } } } });
    await oauth.login("devin", "oauth", { notify: () => {}, prompt: async (prompt) => prompt.type === "select" ? "manual" : "ordinary-oauth-code" });
    const refresh = await oauth.refresh({ providers: ["devin"], allowNetwork: true, force: true });
    assert.equal(refresh.errors.size, 0);
    const model = oauth.getModels("devin").find((entry) => entry.id === "swe-2")!;
    for (const apiKey of [serviceKey, windsurfKey]) {
      const rejected = await attempt(oauth, { apiKey }, model);
      assert.equal(rejected.errorMessage, OAUTH_ONLY_MESSAGE);
      assert.deepEqual(rejected.requests, []);
    }
    const accepted = await attempt(oauth, {}, model);
    assert.equal(accepted.stopReason, "stop", accepted.errorMessage);
    const chat = accepted.requests.find((request) => request.method === CHAT_METHOD)!;
    assert.equal((chat.body.metadata as JsonObject).apiKey, providerCredential.sessionToken);
    assert.equal(accepted.requests.every((request) => !JSON.stringify(request.body).includes(serviceKey) && !JSON.stringify(request.body).includes(windsurfKey)), true);
  } finally {
    for (const provider of providers) (provider as ReturnType<typeof createDevinProvider>).shutdown();
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});

test("coding-agent public ModelRuntime real file storage is bounded and Pi logout keeps the CLI credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-host-auth-"));
  const authPath = join(directory, "auth.json"), cliPath = join(directory, "cli-credentials.json");
  const other = { type: "api_key", key: "unrelated-fake-token" };
  const cliBytes = JSON.stringify({ version: 1, sessionToken: "independent-cli-fake-token" });
  await writeFile(authPath, JSON.stringify({ unrelated: other }), { mode: 0o600 });
  await writeFile(cliPath, cliBytes, { mode: 0o600 });
  let queries = 0;
  const auth = createDevinAccountAuth({
    loginOptions: { fetch: async (url) => unaryResponse(new URL(String(url)).pathname.slice(1), { sessionToken: "file-backed-fake-token" }) },
    createClient: (credential) => new DevinClient(credential, {
      fingerprint: createFingerprintProvider(credential.sessionToken, { collectIdentity: () => identity }),
      fetch: async () => { queries++; return unaryResponse(STATUS_METHOD, statusResponse()); },
    }),
  });
  const provider: Provider = {
    id: "devin", name: "Devin", auth: { oauth: auth }, getModels: () => [],
    refreshModels: async () => {},
    stream: () => { throw new Error("No inference in auth test"); },
    streamSimple: () => { throw new Error("No inference in auth test"); },
  };
  try {
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(provider);
    const credential = await runtime.login("devin", "oauth", {
      notify: () => {}, prompt: async (prompt) => prompt.type === "select" ? "manual" : "plain-file-code",
    });
    assert.equal(runtime.isUsingOAuth("devin"), true);
    assert.equal(queries, 0);
    for (let i = 0; i < 3; i++) await runtime.getAuth("devin");
    assert.equal(queries, 3);
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), { unrelated: other, devin: credential });
    await runtime.logout("devin");
    assert.equal(await runtime.getAuth("devin"), undefined);
    assert.equal(queries, 3);
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), { unrelated: other });
    assert.equal(await readFile(cliPath, "utf8"), cliBytes);
    runtime.unregisterProvider("devin");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
