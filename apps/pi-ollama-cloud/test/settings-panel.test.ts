import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountCredentialStore } from "../src/accounts/credentials.ts";
import { createAccountRouter } from "../src/accounts/router.ts";
import { createSessionAccountBinding } from "../src/accounts/session.ts";
import { type OllamaCommandOptions, registerOllamaCommand, type SettingsControls } from "../src/pi/ollama-command.ts";

const KEY = { up: "\u001b[A", down: "\u001b[B", enter: "\r", escape: "\u001b" };
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const originalFetch = globalThis.fetch;
const originalEnv = {
  agentDir: process.env.PI_CODING_AGENT_DIR,
  key: process.env.OLLAMA_API_KEY,
  tools: process.env.PI_OLLAMA_WEB_TOOLS,
};
let temp: string;
let balanceRequests: number;
let statsRequests: number;
let balanceStatus: number;

interface OpenPanel {
  panel: Component & { handleInput(data: string): void; dispose?(): void };
  result: Promise<unknown>;
  screen(): string;
  press(...keys: string[]): void;
  type(text: string): void;
}

/** Run /ollama in TUI mode and hand back the live panel. */
async function openPanel(options: OllamaCommandOptions = {}) {
  const router = createAccountRouter();
  const appendEntry = vi.fn();
  const binding = createSessionAccountBinding(appendEntry);
  binding.start({ getSessionId: () => "session-1", getEntries: () => [] });
  const state = { usageStatus: false, webTools: true };
  const controls: SettingsControls = {
    isUsageStatusEnabled: () => state.usageStatus,
    setUsageStatusEnabled: vi.fn((enabled: boolean) => {
      state.usageStatus = enabled;
    }),
    areWebToolsEnabled: () => state.webTools,
    setWebToolsEnabled: vi.fn((enabled: boolean) => {
      state.webTools = enabled;
    }),
  };
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  registerOllamaCommand(
    {
      registerCommand(_name: string, command: { handler: typeof handler }) {
        handler = command.handler;
      },
    } as unknown as ExtensionAPI,
    { router, binding },
    controls,
    options,
  );
  const notify = vi.fn();
  let opened!: (value: OpenPanel) => void;
  const ready = new Promise<OpenPanel>((resolve) => {
    opened = resolve;
  });
  const custom = vi.fn((factory: (...args: unknown[]) => OpenPanel["panel"]) => {
    return new Promise((resolve) => {
      const panel = factory({ requestRender() {} }, theme, {}, resolve);
      const screen = () => {
        const lines = panel.render(100);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
        return stripTerminalSequences(lines.join("\n"));
      };
      opened({
        panel,
        result: Promise.resolve(),
        screen,
        press: (...keys) => {
          for (const key of keys) panel.handleInput(key);
        },
        type: (text) => {
          for (const character of text) panel.handleInput(character);
        },
      });
    });
  });
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: join(temp, "project"),
    modelRegistry: { getApiKeyForProvider: async () => "key-default-secret" },
    ui: { notify, custom },
  } as unknown as ExtensionCommandContext;
  if (!handler) throw new Error("/ollama is not registered");
  const finished = handler("", ctx);
  const view = await ready;
  return { ...view, finished, notify, controls, binding, router, appendEntry };
}

beforeAll(() => {
  initTheme("dark", false);
});

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "ollama-settings-panel-"));
  mkdirSync(join(temp, "project"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
  delete process.env.OLLAMA_API_KEY;
  delete process.env.PI_OLLAMA_WEB_TOOLS;
  balanceRequests = 0;
  statsRequests = 0;
  balanceStatus = 200;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("Authorization");
    if (String(input).includes("/api/usage")) {
      statsRequests += 1;
      return Response.json({ range: "7d", totals: { request_count: 3 } });
    }
    balanceRequests += 1;
    if (balanceStatus !== 200) return Response.json({ error: "too many requests" }, { status: balanceStatus });
    if (key === "Bearer bad-key-123") return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({
      included: { session: { remaining_percent: key === "Bearer key-default-secret" ? 60 : 90 } },
      purchased: { balance_usd: 0 },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of [
    ["PI_CODING_AGENT_DIR", originalEnv.agentDir],
    ["OLLAMA_API_KEY", originalEnv.key],
    ["PI_OLLAMA_WEB_TOOLS", originalEnv.tools],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(temp, { recursive: true, force: true });
});

describe("/ollama settings panel", () => {
  it("shows the toggles and each account's key prefix, refreshed usage, and status", async () => {
    const { screen, press, finished } = await openPanel();
    expect(screen()).toMatch(/Usage status bar\s+off/);
    expect(screen()).toMatch(/Web tools\s+on/);
    await vi.waitFor(() => expect(screen()).toMatch(/default\s+key-de… {2}5h 40% used {2}available/));
    expect(screen()).not.toContain("key-default-secret");
    expect(screen()).toContain("+ Add account");
    press(KEY.escape);
    await finished;
  });

  it("toggles the status bar and web tools and saves both to the global config", async () => {
    const { screen, press, controls, finished } = await openPanel();
    press(KEY.enter);
    await vi.waitFor(() => expect(screen()).toContain("Usage status bar on. Saved to"));
    expect(controls.setUsageStatusEnabled).toHaveBeenCalledWith(true, expect.anything());
    press(KEY.down, KEY.enter);
    await vi.waitFor(() => expect(screen()).toContain("Web tools off. Saved to"));
    expect(controls.setWebToolsEnabled).toHaveBeenCalledWith(false);
    expect(JSON.parse(readFileSync(join(temp, "agent", "ollama-cloud.json"), "utf8"))).toEqual({
      usageStatus: true,
      webTools: false,
    });
    press(KEY.escape);
    await finished;
  });

  it("asks for the masked key first, then a name prefilled with an unused default", async () => {
    const { screen, press, type, finished } = await openPanel();
    press(KEY.up, KEY.enter);
    expect(screen()).toContain("Paste the Ollama Cloud API key");
    type("work-key-secret");
    expect(screen()).toContain("work-k•••••••••");
    expect(screen()).not.toContain("work-key-secret");
    press(KEY.enter);
    expect(screen()).toContain("Account name");
    expect(screen()).toContain("account-1 (Enter to use)");
    type("Work");
    press(KEY.enter);
    expect(screen()).toContain("Account IDs use 1-32 lowercase letters");
    for (let index = 0; index < 4; index++) press("\u007f");
    type("work");
    press(KEY.enter);
    await vi.waitFor(() => expect(screen()).toContain('Added Ollama Cloud account "work". 5h 10% used'));
    expect(screen()).toMatch(/work\s+work-k… {2}5h 10% used {2}available/);
    expect(JSON.parse(readFileSync(join(temp, "agent", "ollama-cloud-accounts.json"), "utf8"))).toEqual({
      work: { type: "api_key", key: "work-key-secret" },
    });
    press(KEY.escape);
    await finished;
  });

  it("never shows a key pasted into the name field in full", async () => {
    const pasted = "d395c94932f94c0fbd35fa83fbb3f3b8.fixtureSecretPart";
    const { screen, press, type, finished } = await openPanel();
    press(KEY.up, KEY.enter);
    type("work-key-secret");
    press(KEY.enter);
    type(pasted);
    expect(screen()).toContain("d395c9•••");
    expect(screen()).not.toContain(pasted);
    expect(screen()).not.toContain("fixtureSecretPart");
    press(KEY.enter);
    expect(screen()).toContain("That looks like an API key. This field is the account name");
    expect(screen()).not.toContain(pasted);
    press(KEY.escape);
    expect(screen()).toContain("+ Add account");
    press(KEY.escape);
    await finished;
  });

  it("accepts the suggested name and does not keep a key Ollama rejects", async () => {
    const { screen, press, type, finished } = await openPanel();
    press(KEY.up, KEY.enter);
    type("bad-key-123");
    press(KEY.enter, KEY.enter);
    await vi.waitFor(() => expect(screen()).toContain('Ollama Cloud rejected the key for "account-1"'));
    expect(screen()).not.toMatch(/account-1\s+bad-ke…/);
    press(KEY.escape);
    await finished;
  });

  it("uses, disables, and removes an account from its action menu", async () => {
    await createAccountCredentialStore(join(temp, "agent", "ollama-cloud-accounts.json")).add(
      "work",
      "work-key-secret",
    );
    const { screen, press, binding, router, appendEntry, finished } = await openPanel();
    await vi.waitFor(() => expect(screen()).toMatch(/work\s+work-k…/));
    press(KEY.down, KEY.down, KEY.down, KEY.enter);
    expect(screen()).toContain("Account work");
    press(KEY.enter);
    await vi.waitFor(() => expect(screen()).toContain('This session now uses Ollama Cloud account "work".'));
    expect(binding.accountId).toBe("work");
    expect(appendEntry).toHaveBeenCalledWith("ollama-cloud-account", { sessionId: "session-1", accountId: "work" });
    expect(screen()).toMatch(/work \*/);

    press(KEY.enter, KEY.enter);
    await vi.waitFor(() => expect(screen()).toContain('Account "work" disabled.'));
    expect(router.readState().disabledAccountIds).toEqual(["work"]);
    expect(screen()).toMatch(/work \*\s+work-k….*disabled/);

    press(KEY.enter, KEY.down, KEY.down, KEY.enter);
    expect(screen()).toContain('Remove "work" from the accounts file?');
    press(KEY.enter);
    await vi.waitFor(() => expect(screen()).toContain('Removed Ollama Cloud account "work".'));
    expect(screen()).not.toMatch(/work-k…/);
    press(KEY.escape);
    await finished;
  });

  it("shows the usage report directly under the title", async () => {
    const { screen, press, finished } = await openPanel();
    await vi.waitFor(() => expect(screen()).toContain("Updated"));
    const lines = screen().split("\n");
    expect(lines[0]).toBe("Ollama Cloud");
    expect(lines[1]).toMatch(/^ {2}default {2}5h ▕████░░░░░░▏ 40%$/);
    expect(lines[2]).toMatch(/^ +7d: 3 requests$/);
    expect(lines[3]).toMatch(/^ {2}Updated \d\d:\d\d:\d\d · refreshes every 5s while open$/);
    expect(screen()).not.toContain("Usage report");
    press(KEY.escape);
    await finished;
  });

  it("refreshes the report only while the panel is open, with statistics throttled", async () => {
    const { press, finished } = await openPanel({ reportIntervalMs: 20, statsIntervalMs: 60_000 });
    await vi.waitFor(() => expect(balanceRequests).toBeGreaterThanOrEqual(4));
    expect(statsRequests).toBe(1);
    press(KEY.escape);
    await finished;
    const afterClose = balanceRequests;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(balanceRequests).toBe(afterClose);
  });

  it("backs off after a rate-limited balance check", async () => {
    balanceStatus = 429;
    const { screen, press, finished } = await openPanel({ reportIntervalMs: 20 });
    await vi.waitFor(() => expect(screen()).toContain("rate limited, next check in 30s"));
    expect(screen()).toContain("Ollama Cloud balance failed: rate limited");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(balanceRequests).toBe(1);
    press(KEY.escape);
    await finished;
  });

  it("locks web tools while PI_OLLAMA_WEB_TOOLS turns them off", async () => {
    process.env.PI_OLLAMA_WEB_TOOLS = "off";
    const { screen, press, controls, finished } = await openPanel();
    press(KEY.down, KEY.enter);
    expect(controls.setWebToolsEnabled).not.toHaveBeenCalled();
    expect(screen()).toContain("Disabled by PI_OLLAMA_WEB_TOOLS");
    press(KEY.escape);
    await finished;
  });
});
