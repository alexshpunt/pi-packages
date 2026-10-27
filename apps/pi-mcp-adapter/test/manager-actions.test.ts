/**
 * The `/mcp` manager's actions that only the TUI offers, run through the servers service: enabling,
 * disabling, and changing the exposure of a server.
 */

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { buildMcpServices } from "../src/app/layer.ts";
import { resolveMcpExtensionOptions } from "../src/app/options.ts";
import { registerMcpExtension } from "../src/pi/registration.ts";
import type { McpServer } from "../src/servers/server.ts";
import type { ServersShape } from "../src/servers/service.ts";
import { startSession, type TestSession } from "./harness.ts";

describe("/mcp manager actions", () => {
  const sessions: TestSession[] = [];
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.shutdown();
  });

  /** A session whose servers service the test drives. */
  const start = async () => {
    let servers: ServersShape | undefined;
    const session = await startSession({
      install: (pi, options) => {
        const resolved = resolveMcpExtensionOptions(options);
        const services = buildMcpServices(pi, resolved);
        servers = services.servers;
        registerMcpExtension(pi, services, resolved);
      },
    });
    sessions.push(session);
    if (!servers) throw new Error("the extension was not installed");
    const service = servers;
    const docs = async (): Promise<McpServer> => {
      const server = await Effect.runPromise(service.find("docs"));
      if (!server) throw new Error("docs is not configured");
      return server;
    };
    return { session, servers: service, docs };
  };

  it("disables and enables a server, closing and reopening its connection", async () => {
    const { session, servers, docs } = await start();

    expect(await Effect.runPromise(servers.setEnabled(await docs(), false))).toBeUndefined();
    expect(session.updates).toEqual([{ name: "docs", patch: { enabled: false } }]);
    expect(session.closed).toEqual(["docs"]);
    expect(session.tools.get("mcp__docs__echo")?.exposure).toBe("hidden");
    await expect(session.call("mcp__docs__echo")).rejects.toThrow('MCP server "docs" is disabled.');

    expect(await Effect.runPromise(servers.setEnabled(await docs(), true))).toBeUndefined();
    expect(session.updates.at(-1)).toEqual({ name: "docs", patch: { enabled: true } });
    expect(session.opened).toEqual(["docs", "docs"]);
    expect(session.tools.get("mcp__docs__echo")?.exposure).toBe("direct");
    expect(await session.call("mcp__docs__echo")).toBe("ok");
  });

  it("re-registers the tools with a changed exposure", async () => {
    const { session, servers, docs } = await start();

    expect(await Effect.runPromise(servers.setExposure(await docs(), "codemode"))).toBeUndefined();
    expect(session.updates).toEqual([{ name: "docs", patch: { exposure: "codemode" } }]);
    expect(session.tools.get("mcp__docs__echo")?.exposure).toBe("deferred");
  });
});
