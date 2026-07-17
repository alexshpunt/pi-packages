import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getCloudApiKey } from "../web-tools.ts";

// --- Helpers ---

/**
 * Build a fake ExtensionContext whose modelRegistry.getApiKeyForProvider
 * returns the given key. We do NOT import AuthStorage: it is not exported on
 * pi 0.80.8+ and the import would fail.
 */
function fakeCtx(storedKey: string | undefined): Pick<ExtensionContext, "modelRegistry"> {
  return {
    modelRegistry: {
      getApiKeyForProvider: async (_provider: string) => storedKey,
    } as unknown as ModelRegistry,
  };
}

// --- Tests ---

describe("getCloudApiKey", () => {
  const originalEnv = process.env.OLLAMA_API_KEY;

  beforeEach(() => {
    delete process.env.OLLAMA_API_KEY;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalEnv;
  });

  it("returns the stored key when getApiKeyForProvider resolves one", async () => {
    const apiKey = await getCloudApiKey(fakeCtx("stored-key"));
    expect(apiKey).toBe("stored-key");
  });

  it("falls back to OLLAMA_API_KEY env var when no stored key is resolved (#24 regression)", async () => {
    process.env.OLLAMA_API_KEY = "env-key";
    const apiKey = await getCloudApiKey(fakeCtx(undefined));
    expect(apiKey).toBe("env-key");
  });

  it("returns undefined when neither a stored key nor the env var is set", async () => {
    const apiKey = await getCloudApiKey(fakeCtx(undefined));
    expect(apiKey).toBeUndefined();
  });

  it("prefers the stored key over the OLLAMA_API_KEY env var", async () => {
    process.env.OLLAMA_API_KEY = "env-key";
    const apiKey = await getCloudApiKey(fakeCtx("stored-key"));
    expect(apiKey).toBe("stored-key");
  });
});