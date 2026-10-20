import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountCredentialStore } from "../src/accounts/credentials.ts";
import { createAccountRouter } from "../src/accounts/router.ts";
import { createSessionAccountBinding } from "../src/accounts/session.ts";
import { createAccountStateStore } from "../src/accounts/state.ts";
import { createCache } from "../src/cache/storage.ts";
import { createAccountRequestRunner } from "../src/pi/account-requests.ts";
import { registerWebFetchTool, registerWebSearchTool } from "../src/pi/web-tools.ts";

const usageLimit = { error: "you (fixture) have reached your session usage limit, upgrade for higher limits" };
const originalFetch = globalThis.fetch;
const originalKey = process.env.OLLAMA_API_KEY;
let directory: string;

function setup(entries: { id: string; apiKey: string }[], primaryKey: string | null = "key-default") {
  const credentialsPath = join(directory, "accounts.json");
  writeFileSync(credentialsPath, JSON.stringify(entries.map((entry) => entry.id)));
  const credentials: AccountCredentialStore = {
    path: credentialsPath,
    list: async () => entries.map((entry) => entry.id),
    resolve: async () => entries,
    add: async () => {},
    remove: async () => true,
  };
  const router = createAccountRouter({
    credentials,
    state: createAccountStateStore({ path: join(directory, "state.json") }),
    fetchBalance: async () => ({ included: { balance_usd: 80, allowance_usd: 100 }, purchased: { balance_usd: 0 } }),
  });
  const binding = createSessionAccountBinding(() => {});
  binding.start({ getSessionId: () => "session-1", getEntries: () => [] });
  const runner = createAccountRequestRunner(router, binding);
  const tools = new Map<string, ToolDefinition>();
  const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
  const cache = createCache({ path: join(directory, "cache.json") });
  registerWebSearchTool(pi, cache, runner);
  registerWebFetchTool(pi, cache, runner);
  const ctx = { modelRegistry: { getApiKeyForProvider: async () => primaryKey ?? undefined } };
  const execute = (name: string, params: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing ${name}`);
    return tool.execute("call", params as never, new AbortController().signal, undefined, ctx as never);
  };
  return { execute, binding, router };
}

function mockWeb(respond: (path: string, authorization: string | null) => Response) {
  const authorizations: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const authorization = new Headers(init?.headers).get("Authorization");
    if (path !== "/api/balance") authorizations.push(`${path} ${authorization}`);
    return respond(path, authorization);
  }) as typeof fetch;
  return authorizations;
}

const searchResult = () =>
  Response.json({ results: [{ title: "fixture", url: "https://example.test", content: "fixture body" }] });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ollama-account-requests-"));
  delete process.env.OLLAMA_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OLLAMA_API_KEY;
  else process.env.OLLAMA_API_KEY = originalKey;
  rmSync(directory, { recursive: true, force: true });
});

describe("web tools with multiple accounts", () => {
  it("repeats a search with the next account after a usage limit and keeps the session there", async () => {
    const { execute, binding } = setup([{ id: "work", apiKey: "key-work" }]);
    const requests = mockWeb((_path, authorization) =>
      authorization === "Bearer key-default" ? Response.json(usageLimit, { status: 429 }) : searchResult(),
    );
    const result = await execute("ollama_web_search", { query: "fixture", max_results: 3 });
    expect(JSON.stringify(result)).toContain("fixture body");
    expect(requests).toEqual(["/api/web_search Bearer key-default", "/api/web_search Bearer key-work"]);
    expect(binding.accountId).toBe("work");
    await execute("ollama_web_search", { query: "other", max_results: 3 });
    expect(requests.at(-1)).toBe("/api/web_search Bearer key-work");
  });

  it("repeats a page fetch with the next account after a rejected key", async () => {
    const { execute } = setup([{ id: "work", apiKey: "key-work" }]);
    const requests = mockWeb((_path, authorization) =>
      authorization === "Bearer key-default"
        ? Response.json({ error: "unauthorized" }, { status: 401 })
        : Response.json({ title: "page", content: "page body", links: [] }),
    );
    const result = await execute("ollama_web_fetch", { url: "https://example.test/page" });
    expect(JSON.stringify(result)).toContain("page body");
    expect(requests).toEqual(["/api/web_fetch Bearer key-default", "/api/web_fetch Bearer key-work"]);
  });

  it.each([
    [403, { error: "forbidden" }],
    [429, { error: "too many requests" }],
    [500, { error: "boom" }],
  ] as const)("returns %s errors without switching accounts", async (status, body) => {
    const { execute, binding } = setup([{ id: "work", apiKey: "key-work" }]);
    const requests = mockWeb(() => Response.json(body, { status }));
    await expect(execute("ollama_web_search", { query: "fixture", max_results: 3 })).rejects.toThrow();
    expect(requests).toEqual(["/api/web_search Bearer key-default"]);
    expect(binding.accountId).toBe("default");
  });

  it("surfaces the last account's error when every account hits its limit", async () => {
    const { execute } = setup([{ id: "work", apiKey: "key-work" }]);
    const requests = mockWeb(() => Response.json(usageLimit, { status: 429 }));
    await expect(execute("ollama_web_search", { query: "fixture", max_results: 3 })).rejects.toThrow(
      /usage limit reached/,
    );
    expect(requests).toHaveLength(2);
    await expect(execute("ollama_web_search", { query: "again", max_results: 3 })).rejects.toThrow(/quota exceeded/);
    expect(requests).toHaveLength(2);
  });

  it("keeps the missing-key error when no account is configured", async () => {
    const { execute } = setup([], null);
    rmSync(join(directory, "accounts.json"), { force: true });
    mockWeb(() => searchResult());
    await expect(execute("ollama_web_search", { query: "fixture", max_results: 3 })).rejects.toThrow(
      "No Ollama Cloud API key configured",
    );
  });
});
