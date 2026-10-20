import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountCredentialStore, StoredAccountKey } from "../src/accounts/credentials.ts";
import { createAccountRouter } from "../src/accounts/router.ts";
import { createSessionAccountBinding } from "../src/accounts/session.ts";
import { createAccountStateStore } from "../src/accounts/state.ts";
import { showCloudUsage } from "../src/pi/usage-command.ts";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OLLAMA_API_KEY;
let directory: string;
let requests: string[];

function setup(entries: StoredAccountKey[], primaryKey: string | null = "key-default") {
  const path = join(directory, "accounts.json");
  writeFileSync(path, JSON.stringify(entries.map((entry) => entry.id)));
  const credentials: AccountCredentialStore = {
    path,
    list: async () => entries.map((entry) => entry.id),
    resolve: async () => entries,
    add: async () => {},
    remove: async () => true,
  };
  const router = createAccountRouter({
    credentials,
    state: createAccountStateStore({ path: join(directory, "s.json") }),
  });
  const binding = createSessionAccountBinding(() => {});
  binding.start({ getSessionId: () => "session-1", getEntries: () => [] });
  const notify = vi.fn();
  const ctx = {
    modelRegistry: { getApiKeyForProvider: async () => primaryKey ?? undefined },
    ui: { notify },
  } as unknown as ExtensionContext;
  return { services: { router, binding }, ctx, notify };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ollama-usage-command-"));
  delete process.env.OLLAMA_API_KEY;
  requests = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "");
    requests.push(`${url.pathname} ${key}`);
    if (key === "key-broken") return Response.json({ error: "boom" }, { status: 500 });
    if (url.pathname === "/api/usage") return Response.json({ range: "7d", totals: { request_count: 12 } });
    return Response.json({
      included: { session: { remaining_percent: key === "key-work" ? 10 : 70 } },
      purchased: { balance_usd: 0 },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OLLAMA_API_KEY;
  else process.env.OLLAMA_API_KEY = originalKey;
  rmSync(directory, { recursive: true, force: true });
});

describe("/ollama usage", () => {
  it("keeps the single-account report unchanged", async () => {
    const { services, ctx, notify } = setup([]);
    await showCloudUsage(ctx, services);
    expect(requests).toEqual(["/api/balance key-default", "/api/usage key-default"]);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]).toEqual(["Ollama Cloud usage:\n  5h: 30% used\n  Requests (7d): 12", "info"]);
  });

  it("reports every account, request statistics for the session's account, and unusable entries", async () => {
    const { services, ctx, notify } = setup([
      { id: "work", apiKey: "key-work" },
      { id: "broken", apiKey: "key-broken" },
      { id: "missing", error: "The API key or its $ENV/!command reference could not be resolved." },
    ]);
    services.binding.bind("work");
    const { accounts } = await services.router.listAccounts("key-default");
    await services.router.reportFailure(accounts[1], { kind: "usage-limit", window: "session" });
    await services.router.settle();
    requests = [];
    await showCloudUsage(ctx, services);
    expect(requests).toEqual([
      "/api/balance key-default",
      "/api/balance key-work",
      "/api/usage key-work",
      "/api/balance key-broken",
    ]);
    const [report, level] = notify.mock.calls[0];
    expect(level).toBe("info");
    expect(report).toContain("Ollama Cloud usage [default]:\n  5h: 30% used");
    expect(report).toContain("Ollama Cloud usage [work] (this session):\n  5h: 90% used\n  Requests (7d): 12");
    expect(report).toMatch(/Account status: session usage limit reached until/);
    expect(report).toMatch(/Ollama Cloud usage \[broken\]: unavailable \(.*server error/);
    expect(report).toContain("Ollama Cloud account [missing] unusable:");
  });

  it("reports a missing key", async () => {
    const { services, ctx, notify } = setup([], null);
    rmSync(join(directory, "accounts.json"));
    await showCloudUsage(ctx, services);
    expect(notify).toHaveBeenCalledWith(
      "No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.",
      "error",
    );
    expect(requests).toEqual([]);
  });
});
