import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.ts";
import { createUsageStatusRefreshGuard, resolveUsageStatusToggle } from "../src/usage/status.ts";

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;

// Footer and usage refreshes record balances in the agent directory; keep them out of the real one.
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "ollama-usage-status-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

describe("createUsageStatusRefreshGuard", () => {
  it("preserves the caller cancellation signal and discards its late result", async () => {
    const guard = createUsageStatusRefreshGuard();
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let finish!: (value: string) => void;
    const status = vi.fn();
    const task = guard.run(
      () => true,
      (_current, signal) => {
        requestSignal = signal;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
      status,
      caller.signal,
    );
    try {
      caller.abort();
      expect(requestSignal?.aborted).toBe(true);
      finish("late");
      await task;
      expect(status).not.toHaveBeenCalled();
    } finally {
      caller.abort();
      guard.invalidate();
    }
  });

  it("ignores an outstanding result after usage status is stopped", async () => {
    const guard = createUsageStatusRefreshGuard();
    let resolveRefresh!: (value: string | undefined) => void;
    const refresh = vi.fn(() => new Promise<string | undefined>((resolve) => (resolveRefresh = resolve)));
    const setStatus = vi.fn();
    const task = guard.run(() => true, refresh, setStatus);

    guard.invalidate();
    resolveRefresh("stale usage");
    await task;

    expect(setStatus).not.toHaveBeenCalled();
  });

  it("ignores an outstanding result after the active provider changes", async () => {
    const guard = createUsageStatusRefreshGuard();
    let providerIsCloud = true;
    let resolveRefresh!: (value: string | undefined) => void;
    const setStatus = vi.fn();
    const task = guard.run(
      () => providerIsCloud,
      () => new Promise<string | undefined>((resolve) => (resolveRefresh = resolve)),
      setStatus,
    );

    providerIsCloud = false;
    guard.invalidate();
    resolveRefresh("stale usage");
    await task;

    expect(setStatus).not.toHaveBeenCalled();
  });

  it("starts a fresh generation after stop while the stale request remains pending", async () => {
    const guard = createUsageStatusRefreshGuard();
    let resolveOld!: (value: string | undefined) => void;
    let resolveCurrent!: (value: string | undefined) => void;
    const refresh = vi
      .fn<(stillCurrent: () => boolean) => Promise<string | undefined>>()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveCurrent = resolve)));
    const setStatus = vi.fn();

    const oldTask = guard.run(() => true, refresh, setStatus);
    guard.invalidate();
    const currentTask = guard.run(() => true, refresh, setStatus);
    expect(refresh).toHaveBeenCalledTimes(2);

    resolveOld("stale");
    await oldTask;
    const overlappingCurrentTask = guard.run(() => true, refresh, setStatus);
    expect(refresh).toHaveBeenCalledTimes(2);

    resolveCurrent("current");
    await Promise.all([currentTask, overlappingCurrentTask]);
    expect(setStatus).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith("current");
  });

  it("runs only one refresh for overlapping timer and agent-end triggers", async () => {
    const guard = createUsageStatusRefreshGuard();
    let resolveRefresh!: (value: string | undefined) => void;
    const refresh = vi.fn(() => new Promise<string | undefined>((resolve) => (resolveRefresh = resolve)));
    const setStatus = vi.fn();
    const first = guard.run(() => true, refresh, setStatus);
    const overlapping = guard.run(() => true, refresh, setStatus);

    expect(refresh).toHaveBeenCalledTimes(1);
    resolveRefresh("usage");
    await Promise.all([first, overlapping]);
    expect(setStatus).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith("usage");
  });
});

describe("usage status event wiring", () => {
  it.each(["off", "model_select", "session_shutdown"])(
    "aborts the actual balance request and clears timers on %s",
    async (stop) => {
      vi.useFakeTimers();
      const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
      const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
      const pi = {
        registerProvider() {},
        registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
          commands.set(name, options.handler);
        },
        on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
          events.set(event, handler);
        },
      };
      await extension(pi as unknown as ExtensionAPI);
      const signals: AbortSignal[] = [];
      globalThis.fetch = vi.fn(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error("Missing fetch signal");
            signals.push(signal);
            signal.addEventListener("abort", () => reject(new DOMException("fixture abort", "AbortError")), {
              once: true,
            });
          }),
      );
      const notify = vi.fn();
      const context = (provider = "ollama-cloud", mode = "tui") => ({
        mode,
        model: { provider },
        cwd: process.cwd(),
        modelRegistry: { getApiKeyForProvider: async () => "fixture" },
        ui: { setStatus: vi.fn(), notify, theme: { fg: (_color: string, text: string) => text } },
      });
      const ctx = context();
      await commands.get("ollama")!("status on", ctx);
      await vi.advanceTimersByTimeAsync(0);
      expect(signals).toHaveLength(1);
      if (stop === "off") await commands.get("ollama")!("status off", ctx);
      else await events.get(stop)!({}, context("other"));
      await vi.advanceTimersByTimeAsync(0);
      expect(signals[0].aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(notify.mock.calls.some((args) => args[1] === "error")).toBe(false);

      for (const mode of ["rpc", "json", "print"]) {
        await commands.get("ollama")!("status on", context("ollama-cloud", mode));
        await vi.advanceTimersByTimeAsync(0);
        expect(signals).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );

  it("does not cancel an explicit usage command when the footer is turned off", async () => {
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
    await extension({
      registerProvider() {},
      on() {},
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, options.handler);
      },
    } as unknown as ExtensionAPI);
    const requests: { signal: AbortSignal; finish: () => void }[] = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("/api/usage")) return Response.json({ totals: { request_count: 1 } });
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Missing fetch signal");
        const abort = () => reject(new DOMException("fixture abort", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        requests.push({
          signal,
          finish: () => {
            signal.removeEventListener("abort", abort);
            resolve(Response.json({ included: { monthly: { remaining_percent: 80 } } }));
          },
        });
      });
    });
    const ctx = {
      mode: "tui",
      model: { provider: "ollama-cloud" },
      cwd: process.cwd(),
      modelRegistry: { getApiKeyForProvider: async () => "fixture" },
      ui: { setStatus: vi.fn(), notify: vi.fn(), theme: { fg: (_color: string, text: string) => text } },
    };
    try {
      await commands.get("ollama")!("status on", ctx);
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const manual = commands.get("ollama")!("usage", ctx);
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      await commands.get("ollama")!("status off", ctx);
      expect(requests[0].signal.aborted).toBe(true);
      expect(requests[1].signal.aborted).toBe(false);
      requests[1].finish();
      await manual;
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Ollama Cloud usage"), "info");
    } finally {
      await commands.get("ollama")!("status off", ctx);
    }
  });

  it("restarts after provider stop and ignores results after session shutdown", async () => {
    const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
    const pi = {
      registerProvider() {},
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, options.handler);
      },
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
        events.set(event, handler);
      },
      getAllTools: () => [{ name: "ollama_web_search" }, { name: "ollama_web_fetch" }],
      getActiveTools: () => [],
      setActiveTools() {},
    };
    await extension(pi as unknown as ExtensionAPI);

    const pendingResponses: Array<(response: Response) => void> = [];
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => pendingResponses.push(resolve))) as typeof fetch;
    const status = vi.fn();
    const context = (provider: string): ExtensionContext =>
      ({
        mode: "tui",
        cwd: process.cwd(),
        model: { provider },
        modelRegistry: { getApiKeyForProvider: async () => "test-key" },
        ui: { setStatus: status, notify() {}, theme: { fg: (_color: string, text: string) => text } },
      }) as unknown as ExtensionContext;
    const invoke = async (event: string, ctx: ExtensionContext) => {
      await events.get(event)?.({}, ctx);
    };
    const ollama = commands.get("ollama");
    const command = ollama && ((arg: string, ctx: unknown) => ollama(`status ${arg}`, ctx));
    expect(command).toBeDefined();
    await command!("on", context("ollama-cloud"));
    await vi.waitFor(() => expect(pendingResponses).toHaveLength(1));

    await invoke("model_select", context("other-provider"));
    status.mockClear();
    await invoke("model_select", context("ollama-cloud"));
    await vi.waitFor(() => expect(pendingResponses).toHaveLength(2));

    pendingResponses[0](new Response(JSON.stringify({ included: { monthly: { remaining_percent: 80 } } })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(status).not.toHaveBeenCalled();
    pendingResponses[1](new Response(JSON.stringify({ included: { monthly: { remaining_percent: 60 } } })));
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith("ollama-usage", expect.stringContaining("40%")));

    await invoke("model_select", context("other-provider"));
    await invoke("model_select", context("ollama-cloud"));
    await vi.waitFor(() => expect(pendingResponses).toHaveLength(3));
    status.mockClear();
    await invoke("session_shutdown", context("ollama-cloud"));
    status.mockClear();
    pendingResponses[2](new Response(JSON.stringify({ included: { monthly: { remaining_percent: 20 } } })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(status).not.toHaveBeenCalled();
  });

  it("coalesces event/timer overlap and ignores a delayed API key after restart", async () => {
    vi.useFakeTimers();
    const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
    const pi = {
      registerProvider() {},
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, options.handler);
      },
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
        events.set(event, handler);
      },
      getAllTools: () => [{ name: "ollama_web_search" }, { name: "ollama_web_fetch" }],
      getActiveTools: () => [],
      setActiveTools() {},
    };
    await extension(pi as unknown as ExtensionAPI);

    const pendingKeys: Array<(key: string | undefined) => void> = [];
    const getApiKey = vi.fn(() => new Promise<string | undefined>((resolve) => pendingKeys.push(resolve)));
    const context = (): ExtensionContext =>
      ({
        mode: "tui",
        cwd: process.cwd(),
        model: { provider: "ollama-cloud" },
        modelRegistry: { getApiKeyForProvider: getApiKey },
        ui: { setStatus: vi.fn(), notify() {}, theme: { fg: (_color: string, text: string) => text } },
      }) as unknown as ExtensionContext;
    const invoke = async (event: string, ctx: ExtensionContext) => {
      await events.get(event)?.({}, ctx);
    };
    const pendingResponses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => pendingResponses.push(resolve)),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const ollama = commands.get("ollama");
    const command = ollama && ((arg: string, ctx: unknown) => ollama(`status ${arg}`, ctx));
    expect(command).toBeDefined();
    const ctx = context();
    await command!("on", ctx);
    await Promise.resolve();
    expect(getApiKey).toHaveBeenCalledTimes(1);

    await invoke("agent_end", ctx);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(getApiKey).toHaveBeenCalledTimes(1);

    await command!("off", ctx);
    await command!("on", ctx);
    await Promise.resolve();
    expect(getApiKey).toHaveBeenCalledTimes(2);

    pendingKeys[0]("stale-key");
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    pendingKeys[1]("current-key");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer current-key" }),
    );
    pendingResponses[0](new Response(JSON.stringify({ included: { monthly: { remaining_percent: 60 } } })));
    await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenCalledWith("ollama-usage", expect.any(String)));
    await invoke("session_shutdown", ctx);
  });
});

describe("resolveUsageStatusToggle", () => {
  it("enables on 'on' and 'enable'", () => {
    expect(resolveUsageStatusToggle("on", false)).toEqual({ enabled: true });
    expect(resolveUsageStatusToggle("enable", false)).toEqual({ enabled: true });
  });

  it("disables on 'off' and 'disable'", () => {
    expect(resolveUsageStatusToggle("off", true)).toEqual({ enabled: false });
    expect(resolveUsageStatusToggle("disable", true)).toEqual({ enabled: false });
  });

  it("toggles with no argument", () => {
    expect(resolveUsageStatusToggle("", true)).toEqual({ enabled: false });
    expect(resolveUsageStatusToggle("", false)).toEqual({ enabled: true });
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(resolveUsageStatusToggle("  ON  ", false)).toEqual({ enabled: true });
  });

  it("returns an error for unknown arguments, keeping the current state", () => {
    const result = resolveUsageStatusToggle("bogus", true);
    expect(result.enabled).toBe(true);
    expect(result.error).toContain("Unknown argument");
  });
});
