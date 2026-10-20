import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountRouter } from "../src/accounts/router.ts";
import { createSessionAccountBinding } from "../src/accounts/session.ts";
import { ollamaCommandCompletions, registerOllamaCommand, type SettingsControls } from "../src/pi/ollama-command.ts";

const originalFetch = globalThis.fetch;
const originalEnv = {
  agentDir: process.env.PI_CODING_AGENT_DIR,
  key: process.env.OLLAMA_API_KEY,
  tools: process.env.PI_OLLAMA_WEB_TOOLS,
};
let temp: string;

function setup(mode = "print") {
  const router = createAccountRouter();
  const binding = createSessionAccountBinding(() => {});
  binding.start({ getSessionId: () => "session-1", getEntries: () => [] });
  let usageStatus = false;
  let webTools = true;
  const controls: SettingsControls & { setUsageStatusEnabled: ReturnType<typeof vi.fn> } = {
    isUsageStatusEnabled: () => usageStatus,
    setUsageStatusEnabled: vi.fn((enabled: boolean) => {
      usageStatus = enabled;
    }),
    areWebToolsEnabled: () => webTools,
    setWebToolsEnabled: vi.fn((enabled: boolean) => {
      webTools = enabled;
    }),
  };
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    registerCommand(name: string, command: { handler: typeof handler }) {
      if (name === "ollama") handler = command.handler;
    },
  } as unknown as ExtensionAPI;
  registerOllamaCommand(pi, { router, binding }, controls);
  const notify = vi.fn();
  const custom = vi.fn();
  const ctx = {
    mode,
    hasUI: mode === "tui",
    cwd: join(temp, "project"),
    modelRegistry: { getApiKeyForProvider: async () => "key-default-secret" },
    ui: { notify, custom },
  } as unknown as ExtensionCommandContext;
  const run = async (args: string) => {
    if (!handler) throw new Error("/ollama is not registered");
    await handler(args, ctx);
    return notify.mock.calls.at(-1) as [string, string];
  };
  return { run, controls, notify, custom, binding };
}

const globalConfig = () => JSON.parse(readFileSync(join(temp, "agent", "ollama-cloud.json"), "utf8"));

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "ollama-command-"));
  mkdirSync(join(temp, "project"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
  delete process.env.OLLAMA_API_KEY;
  delete process.env.PI_OLLAMA_WEB_TOOLS;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/usage")) return Response.json({ range: "7d", totals: { request_count: 3 } });
    return Response.json({ included: { session: { remaining_percent: 75 } }, purchased: { balance_usd: 0 } });
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

describe("/ollama without the TUI", () => {
  it("prints settings and accounts with only the first six key characters", async () => {
    const { run, custom } = setup("print");
    const [summary, level] = await run("");
    expect(level).toBe("info");
    expect(summary).toContain("Usage status bar: off");
    expect(summary).toContain("Web tools: on");
    expect(summary).toContain("default key-de… [Pi credential] available");
    expect(summary).not.toContain("key-default-secret");
    expect(summary).toContain("/ollama status|webtools [on|off]");
    expect(custom).not.toHaveBeenCalled();
  });

  it("shows the usage report", async () => {
    const { run } = setup();
    expect(await run("usage")).toEqual(["Ollama Cloud usage:\n  5h: 25% used\n  Requests (7d): 3", "info"]);
  });

  it("rejects unknown arguments", async () => {
    const { run } = setup();
    for (const args of ["bogus", "usage now", "status on now", "status maybe"]) {
      const [message, level] = await run(args);
      expect(level).toBe("error");
      expect(message).toMatch(/^Usage: \/ollama|Unknown argument/);
    }
  });
});

describe("/ollama toggles", () => {
  it("applies and saves the usage status bar and web tools to the global config", async () => {
    const { run, controls } = setup();
    expect((await run("status on"))[0]).toMatch(/^Usage status bar on\. Saved to .*ollama-cloud\.json\.$/);
    expect(controls.setUsageStatusEnabled).toHaveBeenLastCalledWith(true, expect.anything());
    expect((await run("webtools off"))[1]).toBe("info");
    expect(controls.setWebToolsEnabled).toHaveBeenLastCalledWith(false);
    expect(globalConfig()).toEqual({ usageStatus: true, webTools: false });
    await run("status");
    expect(globalConfig()).toEqual({ usageStatus: false, webTools: false });
  });

  it("keeps other keys in the global file and explains project overrides", async () => {
    mkdirSync(join(temp, "agent"), { recursive: true });
    writeFileSync(join(temp, "agent", "ollama-cloud.json"), JSON.stringify({ futureKey: 1 }));
    mkdirSync(join(temp, "project", ".pi"), { recursive: true });
    writeFileSync(join(temp, "project", ".pi", "ollama-cloud.json"), JSON.stringify({ webTools: true }));
    const { run } = setup();
    const [message, level] = await run("webtools off");
    expect(level).toBe("warning");
    expect(message).toContain("sets webTools to true and takes precedence when Pi starts");
    expect(globalConfig()).toEqual({ futureKey: 1, webTools: false });
  });

  it("applies a toggle for this run without overwriting an unreadable global file", async () => {
    mkdirSync(join(temp, "agent"), { recursive: true });
    writeFileSync(join(temp, "agent", "ollama-cloud.json"), "{broken");
    const { run, controls } = setup();
    const [message, level] = await run("status on");
    expect(level).toBe("warning");
    expect(message).toMatch(/Applied for this run only: .* is not valid JSON/);
    expect(controls.setUsageStatusEnabled).toHaveBeenCalledWith(true, expect.anything());
    expect(readFileSync(join(temp, "agent", "ollama-cloud.json"), "utf8")).toBe("{broken");
  });

  it("refuses to enable web tools while PI_OLLAMA_WEB_TOOLS turns them off", async () => {
    process.env.PI_OLLAMA_WEB_TOOLS = "off";
    const { run, controls } = setup();
    expect((await run("webtools on"))[1]).toBe("error");
    expect(controls.setWebToolsEnabled).not.toHaveBeenCalled();
    expect((await run(""))[0]).toContain("Web tools: off (PI_OLLAMA_WEB_TOOLS)");
  });
});

describe("ollamaCommandCompletions", () => {
  it("completes subcommands and full toggle arguments", () => {
    expect(ollamaCommandCompletions("")?.map((item) => item.value)).toEqual(["usage", "status", "webtools"]);
    expect(ollamaCommandCompletions("w")?.map((item) => item.value)).toEqual(["webtools"]);
    expect(ollamaCommandCompletions("status o")?.map((item) => item.value)).toEqual(["status on", "status off"]);
    expect(ollamaCommandCompletions("usage x")).toBeNull();
  });
});
