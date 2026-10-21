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

function setup(mode: ExtensionCommandContext["mode"] = "print") {
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
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: join(temp, "project"),
    modelRegistry: { getApiKeyForProvider: async () => "key-default-secret" },
    ui: { notify, custom },
  } as unknown as ExtensionCommandContext;
  const run = async (args: string) => {
    if (!handler) throw new Error("/ollama is not registered");
    await handler(args, ctx);
    if (ctx.hasUI) {
      expect(stderr).not.toHaveBeenCalled();
      return notify.mock.calls.at(-1)?.[0] as string;
    }
    expect(notify).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    return String(stderr.mock.calls.at(-1)?.[0] ?? "").trimEnd();
  };
  return { run, controls, notify, custom, binding, router };
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
  vi.restoreAllMocks();
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

describe.each(["print", "json"] as const)("/ollama in %s mode", (mode) => {
  it("writes settings and accounts to stderr with only the first six key characters", async () => {
    const { run, custom } = setup(mode);
    const summary = await run("");
    expect(summary).toContain("Usage status bar: off");
    expect(summary).toContain("Web tools: on");
    expect(summary).toContain("default key-de… [Pi credential] available");
    expect(summary).not.toContain("key-default-secret");
    expect(summary).toContain("/ollama status|webtools [on|off]");
    expect(custom).not.toHaveBeenCalled();
  });

  it("writes the usage report to stderr", async () => {
    const { run } = setup(mode);
    expect(await run("usage")).toBe("Ollama Cloud usage:\n  5h: 25% used\n  Requests (7d): 3");
  });

  it("reports invalid arguments without changing settings", async () => {
    const { run, controls } = setup(mode);
    for (const args of ["bogus", "usage now", "status on now", "status maybe"]) {
      expect(await run(args)).toMatch(/^Usage: \/ollama|Unknown argument/);
    }
    expect(controls.setUsageStatusEnabled).not.toHaveBeenCalled();
    expect(controls.setWebToolsEnabled).not.toHaveBeenCalled();
  });

  it("writes unexpected command failures to stderr", async () => {
    const { run, router } = setup(mode);
    vi.spyOn(router, "listAccounts").mockRejectedValue(new Error("fixture failure"));
    expect(await run("")).toBe("Ollama Cloud: fixture failure");
  });
});

describe.each(["print", "json"] as const)("/ollama toggles in %s mode", (mode) => {
  it("applies and saves the usage status bar and web tools to the global config", async () => {
    const { run, controls } = setup(mode);
    expect(await run("status on")).toMatch(/^Usage status bar on\. Saved to .*ollama-cloud\.json\.$/);
    expect(controls.setUsageStatusEnabled).toHaveBeenLastCalledWith(true, expect.anything());
    expect(await run("webtools off")).toMatch(/^Web tools off\. Saved to .*ollama-cloud\.json\.$/);
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
    const { run } = setup(mode);
    expect(await run("webtools off")).toContain("sets webTools to true and takes precedence when Pi starts");
    expect(globalConfig()).toEqual({ futureKey: 1, webTools: false });
  });

  it("applies a toggle for this run without overwriting an unreadable global file", async () => {
    mkdirSync(join(temp, "agent"), { recursive: true });
    writeFileSync(join(temp, "agent", "ollama-cloud.json"), "{broken");
    const { run, controls } = setup(mode);
    expect(await run("status on")).toMatch(/Applied for this run only: .* is not valid JSON/);
    expect(controls.setUsageStatusEnabled).toHaveBeenCalledWith(true, expect.anything());
    expect(readFileSync(join(temp, "agent", "ollama-cloud.json"), "utf8")).toBe("{broken");
  });

  it("refuses to enable web tools while PI_OLLAMA_WEB_TOOLS turns them off", async () => {
    process.env.PI_OLLAMA_WEB_TOOLS = "off";
    const { run, controls } = setup(mode);
    expect(await run("webtools on")).toContain("Web tools are disabled by PI_OLLAMA_WEB_TOOLS");
    expect(controls.setWebToolsEnabled).not.toHaveBeenCalled();
    expect(await run("")).toContain("Web tools: off (PI_OLLAMA_WEB_TOOLS)");
  });
});

describe.each(["tui", "rpc"] as const)("/ollama with %s UI", (mode) => {
  it("keeps notification levels for results, errors, and save warnings", async () => {
    const { run, notify } = setup(mode);
    await run("status on");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Usage status bar on. Saved to"), "info");
    await run("bogus");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Usage: /ollama"), "error");
    writeFileSync(join(temp, "agent", "ollama-cloud.json"), "{broken");
    await run("status off");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Applied for this run only"), "warning");
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
