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

function setup(entries: StoredAccountKey[], primaryKey: string | null, mode: ExtensionContext["mode"]) {
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
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    modelRegistry: { getApiKeyForProvider: async () => primaryKey ?? undefined },
    ui: { notify },
  } as unknown as ExtensionContext;
  const messages = () => {
    expect(stdout).not.toHaveBeenCalled();
    if (ctx.hasUI) {
      expect(stderr).not.toHaveBeenCalled();
      return notify.mock.calls.map(([text]) => text as string);
    }
    expect(notify).not.toHaveBeenCalled();
    return stderr.mock.calls.map(([text]) => String(text).trimEnd());
  };
  return { services: { router, binding }, ctx, notify, messages };
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
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OLLAMA_API_KEY;
  else process.env.OLLAMA_API_KEY = originalKey;
  rmSync(directory, { recursive: true, force: true });
});

describe.each(["print", "json", "tui", "rpc"] as const)("/ollama usage in %s mode", (mode) => {
  it("keeps the single-account report unchanged", async () => {
    const { services, ctx, messages, notify } = setup([], "key-default", mode);
    await showCloudUsage(ctx, services);
    expect(requests).toEqual(["/api/balance key-default", "/api/usage key-default"]);
    expect(messages()).toEqual(["Ollama Cloud usage:\n  5h: 30% used\n  Requests (7d): 12"]);
    if (ctx.hasUI) expect(notify).toHaveBeenCalledWith(messages()[0], "info");
  });

  it("reports every account, request statistics for the session's account, and unusable entries", async () => {
    const { services, ctx, messages } = setup(
      [
        { id: "work", apiKey: "key-work" },
        { id: "broken", apiKey: "key-broken" },
        { id: "missing", error: "The API key or its $ENV/!command reference could not be resolved." },
      ],
      "key-default",
      mode,
    );
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
    const [report] = messages();
    expect(report).toContain("Ollama Cloud usage [default]:\n  5h: 30% used");
    expect(report).toContain("Ollama Cloud usage [work] (this session):\n  5h: 90% used\n  Requests (7d): 12");
    expect(report).toMatch(/Account status: session usage limit reached until/);
    expect(report).toMatch(/Ollama Cloud usage \[broken\]: unavailable \(.*server error/);
    expect(report).toContain("Ollama Cloud account [missing] unusable:");
  });

  it("reports a missing key", async () => {
    const { services, ctx, messages, notify } = setup([], null, mode);
    rmSync(join(directory, "accounts.json"));
    await showCloudUsage(ctx, services);
    expect(messages()).toEqual(["No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json."]);
    if (ctx.hasUI) expect(notify).toHaveBeenCalledWith(messages()[0], "error");
    expect(requests).toEqual([]);
  });

  it("reports unusable credentials even when no account is available", async () => {
    const { services, ctx, messages, notify } = setup([{ id: "missing", error: "Unresolved reference." }], null, mode);
    await showCloudUsage(ctx, services);
    expect(messages()).toEqual([
      "No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.",
      "Ollama Cloud account [missing] unusable: Unresolved reference.",
    ]);
    if (ctx.hasUI) expect(notify).toHaveBeenLastCalledWith(messages()[1], "warning");
    expect(requests).toEqual([]);
  });

  it("reports a single-account balance failure", async () => {
    const { services, ctx, messages, notify } = setup([], "key-broken", mode);
    await showCloudUsage(ctx, services);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain("server error");
    if (ctx.hasUI) expect(notify).toHaveBeenCalledWith(messages()[0], "error");
    expect(requests).toEqual(["/api/balance key-broken"]);
  });

  it("keeps the balance report and warns when optional statistics fail", async () => {
    const fetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input, init) => {
      if (String(input).includes("/api/usage")) return Response.json({ error: "fixture" }, { status: 500 });
      return fetch(input, init);
    });
    const { services, ctx, messages, notify } = setup([], "key-default", mode);
    await showCloudUsage(ctx, services);
    expect(messages()).toHaveLength(2);
    expect(messages()[0]).toBe("Ollama Cloud usage:\n  5h: 30% used");
    expect(messages()[1]).toMatch(/^Ollama Cloud request statistics unavailable: .*server error/);
    if (ctx.hasUI) expect(notify).toHaveBeenLastCalledWith(messages()[1], "warning");
  });
});
