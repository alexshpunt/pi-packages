/**
 * Connections over a session: startup and its report, waiting for servers, `/mcp` actions,
 * registrations that change, resources, and shutdown.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { McpServerEntry } from "../src/config/schema.ts";
import { SCHEMA, startSession, type TestSession } from "./harness.ts";

const ECHO = { name: "echo", inputSchema: SCHEMA };

function direct(name: string): McpServerEntry {
  return { name, config: { command: name, exposure: "direct" }, source: "test", scope: "global" };
}

describe("MCP server lifecycle", () => {
  const sessions: TestSession[] = [];
  const start = async (options: Parameters<typeof startSession>[0] = {}) => {
    const session = await startSession(options);
    sessions.push(session);
    return session;
  };
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.shutdown();
  });

  it("reports the servers that failed to connect once startup is done", async () => {
    const session = await start({
      config: { servers: [direct("docs"), direct("broken")] },
      servers: { docs: { tools: [ECHO] }, broken: { failure: "cannot start" } },
    });
    // Without a subcommand and outside the TUI, /mcp waits for startup and prints the status.
    await session.command("");

    expect(session.notices).toEqual([
      "MCP servers need attention:\n  broken: failed: cannot start\nRun /mcp to fix.",
      "docs: connected, 1 tools (direct)\nbroken: failed (direct)\n    cannot start",
    ]);
    expect(await session.call("mcp__docs__echo")).toBe("ok");
  });

  it("lets the first prompt wait for a slow direct server only up to startupWaitMs", async () => {
    const session = await start({ servers: { docs: { tools: [ECHO], initializeDelayMs: 200 } }, startupWaitMs: 20 });

    expect(session.notices).toEqual(["MCP servers are still connecting; their tools become available once connected."]);
    expect(session.tools.has("mcp__docs__echo")).toBe(false);
    await session.command("");
    expect(await session.call("mcp__docs__echo")).toBe("ok");
  });

  it("reconnects with /mcp reconnect, and calls wait for the new connection", async () => {
    const session = await start({ servers: { docs: { tools: [ECHO], initializeDelayMs: 50 } } });

    const reconnecting = session.command("reconnect docs");
    // The command first waits for startup, then starts the reconnect.
    await new Promise((resolve) => setTimeout(resolve, 5));
    let isCallReady = false;
    const waiting = session.emit("tool_call", { toolName: "mcp__docs__echo", input: {} }).then(() => {
      isCallReady = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(isCallReady).toBe(false);
    await Promise.all([reconnecting, waiting]);

    expect(session.notices.at(-1)).toBe('Reconnected to MCP server "docs" (connected · 1 tool).');
    expect(session.opened).toEqual(["docs", "docs"]);
    expect(session.closed).toEqual(["docs"]);
    expect(await session.call("mcp__docs__echo")).toBe("ok");
  });

  it("connects servers registered during the session and hides the tools of unregistered ones", async () => {
    const session = await start({ config: { servers: [] }, servers: { extra: { tools: [ECHO] } } });

    session.setRegistered({ extra: { command: "extra", exposure: "direct" }, invalid: { command: 1 } });
    await session.emit("mcp_servers_change", {});
    expect(session.notices).toEqual([
      'MCP servers need attention:\n  config: /ext/registering.ts: server "invalid" needs either "command" (stdio) or "url" (streamable HTTP)\nRun /mcp to fix.',
    ]);
    expect(await session.call("mcp__extra__echo")).toBe("ok");

    session.setRegistered({});
    await session.emit("mcp_servers_change", {});
    expect(session.closed).toEqual(["extra"]);
    expect(session.tools.get("mcp__extra__echo")?.exposure).toBe("hidden");
  });

  it("lists and reads resources through the resource tools", async () => {
    const session = await start({
      servers: { docs: { tools: [ECHO], resources: [{ uri: "file:///notes.txt", name: "notes", text: "hello" }] } },
    });

    expect(session.tools.get("list_mcp_resources")?.exposure).toBe("direct");
    const listed = await session.callResult("list_mcp_resources");
    expect(listed.structuredContent).toEqual({
      resources: [{ server: "docs", uri: "file:///notes.txt", name: "notes" }],
    });
    expect(await session.call("read_mcp_resource", { server: "docs", uri: "file:///notes.txt" })).toContain("hello");
    await expect(session.call("read_mcp_resource", { server: "other", uri: "file:///notes.txt" })).rejects.toThrow(
      'MCP server "other" has no resources. Servers with resources: docs',
    );
  });

  it("closes every connection on session_shutdown and refuses later calls", async () => {
    const session = await start();

    await session.endSession();
    expect(session.closed).toEqual(["docs"]);
    await expect(session.call("mcp__docs__echo")).rejects.toThrow('MCP server "docs" is disabled.');
  });
});
