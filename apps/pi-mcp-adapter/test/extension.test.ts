/**
 * The extension against an in-memory MCP server and a stand-in for the pi API: tool results are cut at
 * the tool's `pi/maxOutputBytes`, else the configured limit, and other extensions get each tool's
 * `_meta` over `pi.events`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedMcpConfig, McpServerConfig } from "../src/config.ts";
import { createMcpExtension } from "../src/index.ts";
import { TOOL_META_CHANNEL, type ToolMeta } from "../src/tool-meta.ts";
import type { McpToolDefinition } from "../src/tools.ts";

/** Bytes of text the `dump` tools return, more than any output limit in the tests. */
const DUMP_BYTES = 100_000;
const SCHEMA = { type: "object", properties: {} };

const TOOLS = [
  { name: "dump", inputSchema: SCHEMA },
  { name: "dump_declared", inputSchema: SCHEMA, _meta: { "pi/maxOutputBytes": 80_000 } },
  { name: "dump_other", inputSchema: SCHEMA, _meta: { "x/limit": 100_000, "x/nested": { list: [1] } } },
  { name: "dump_invalid", inputSchema: SCHEMA, _meta: { "pi/maxOutputBytes": 0 } },
  { name: "text_meta", inputSchema: SCHEMA, _meta: "ab" },
];

/** Bytes of a truncated result's text that reached the model, without header, marker, and file path. */
function keptBytes(text: string): number {
  const [, body = ""] = text.split("\n\n");
  return Buffer.byteLength(body.replace(/…\d+ chars truncated…/, ""));
}

/** An MCP server offering {@link TOOLS}, whose tools return {@link DUMP_BYTES} of text. */
function createServer() {
  const pair = createInMemoryTransportPair();
  const respond = (request: JsonRpcRequest): unknown => {
    switch (request.method) {
      case "initialize":
        return {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "docs", version: "1.0.0" },
        };
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        return { content: [{ type: "text", text: "x".repeat(DUMP_BYTES) }] };
      default:
        return {};
    }
  };
  pair.server.onMessage((message) => {
    if (!("id" in message) || !("method" in message)) return;
    const request = message as JsonRpcRequest;
    queueMicrotask(() => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) }));
  });
  return pair;
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** Load the extension into a stand-in for the pi API and start a session. */
async function start(options: { config?: Partial<LoadedMcpConfig>; registered?: Record<string, unknown> } = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "pi-mcp-adapter-test-"));
  const tools = new Map<string, McpToolDefinition>();
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const events = createEventBus();
  let active: string[] = [];
  const pi = {
    events,
    registerToolRenderer: () => {},
    registerCommand: () => {},
    registerTool: (definition: McpToolDefinition) => {
      tools.set(definition.name, definition);
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getMcpServers: () =>
      Object.entries(options.registered ?? {}).map(([name, config]) => ({
        name,
        config: config as McpServerConfig,
        extensionPath: "/ext/registering.ts",
      })),
    getAllTools: () => [...tools.values()].map((tool) => ({ name: tool.name, exposure: tool.exposure ?? "direct" })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: logDir,
    hasUI: false,
    mode: "print",
    isProjectTrusted: () => false,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionToolContext;
  const config: LoadedMcpConfig = {
    servers: [{ name: "docs", config: { command: "docs", exposure: "direct" }, source: "test", scope: "global" }],
    errors: [],
    ...options.config,
  };
  createMcpExtension({
    loadConfig: () => config,
    createTransport: () => {
      const pair = createServer();
      void pair.server.start();
      return pair.client;
    },
    logPath: join(logDir, "mcp.log"),
    startupWaitMs: 5_000,
  })(pi);
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  // The first prompt waits for servers with direct tools.
  for (const handler of handlers.get("before_agent_start") ?? []) {
    await handler({ systemPromptOptions: { sections: {} } }, ctx);
  }
  const call = async (name: string) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} is not registered`);
    const result = await tool.execute("call", {}, undefined, undefined, ctx);
    return (result.content[0] as TextContent).text;
  };
  const askToolMeta = () => {
    const replies: Record<string, ToolMeta>[] = [];
    events.emit(TOOL_META_CHANNEL, { reply: (meta: Record<string, ToolMeta>) => replies.push(meta) });
    return replies;
  };
  const shutdown = async () => {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    rmSync(logDir, { recursive: true, force: true });
  };
  return { tools, notices, events, call, askToolMeta, shutdown };
}

describe("MCP tool output limit", () => {
  const sessions: { shutdown: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.shutdown();
  });

  it.each([
    { config: {}, server: {}, configured: 20 * 1024 },
    { config: { maxOutputBytes: 30_000 }, server: {}, configured: 30_000 },
    { config: { maxOutputBytes: 30_000 }, server: { maxOutputBytes: 50_000 }, configured: 50_000 },
  ])(
    "cuts results at the tool's pi/maxOutputBytes, else the configured $configured bytes",
    async ({ config, server, configured }) => {
      const session = await start({
        config: {
          ...config,
          servers: [
            {
              name: "docs",
              config: { command: "docs", exposure: "direct", ...server },
              source: "test",
              scope: "global",
            },
          ],
        },
      });
      sessions.push(session);

      // The server entry's value wins over the top-level one, and the tool's `_meta` over both.
      expect(keptBytes(await session.call("mcp__docs__dump"))).toBe(configured);
      expect(keptBytes(await session.call("mcp__docs__dump_declared"))).toBe(80_000);
      // Other keys and an invalid pi/maxOutputBytes leave the configured limit in place.
      expect(keptBytes(await session.call("mcp__docs__dump_other"))).toBe(configured);
      expect(keptBytes(await session.call("mcp__docs__dump_invalid"))).toBe(configured);
    },
  );

  it("uses the maxOutputBytes of a registered server and rejects an invalid one", async () => {
    const session = await start({
      config: { servers: [] },
      registered: {
        large: { command: "docs", exposure: "direct", maxOutputBytes: 60_000 },
        broken: { command: "docs", exposure: "direct", maxOutputBytes: -1 },
      },
    });
    sessions.push(session);

    expect(keptBytes(await session.call("mcp__large__dump"))).toBe(60_000);
    expect(session.tools.has("mcp__broken__dump")).toBe(false);
    expect(session.notices.join("\n")).toContain(
      '/ext/registering.ts: server "broken": maxOutputBytes must be a positive integer',
    );
  });
});

describe("MCP tool _meta for other extensions", () => {
  const sessions: { shutdown: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.shutdown();
  });

  it("puts each tool's _meta on its definition and answers tool-meta requests with it", async () => {
    const session = await start();
    sessions.push(session);
    const expected = {
      mcp__docs__dump_declared: { "pi/maxOutputBytes": 80_000 },
      mcp__docs__dump_other: { "x/limit": 100_000, "x/nested": { list: [1] } },
      mcp__docs__dump_invalid: { "pi/maxOutputBytes": 0 },
    };

    // Tools without `_meta`, or with one that is not an object, have none.
    expect(session.tools.get("mcp__docs__dump")?.meta).toBeUndefined();
    expect(session.tools.get("mcp__docs__text_meta")?.meta).toBeUndefined();
    expect(session.tools.get("mcp__docs__dump_other")?.meta).toEqual(expected.mcp__docs__dump_other);

    const [reply, ...others] = session.askToolMeta();
    expect(others).toEqual([]);
    expect(reply).toEqual(expected);
    // Each reply has its own copies.
    (reply.mcp__docs__dump_declared as Record<string, unknown>)["pi/maxOutputBytes"] = 1;
    expect(session.askToolMeta()).toEqual([expected]);
  });

  it("ignores requests without a reply function", async () => {
    const session = await start();
    sessions.push(session);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      session.events.emit(TOOL_META_CHANNEL, {});
      session.events.emit(TOOL_META_CHANNEL, null);
      // The event bus reports handler errors asynchronously.
      await new Promise((resolve) => setImmediate(resolve));
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
