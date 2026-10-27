/** The extension against in-memory MCP servers and a stand-in for the pi API. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { LoadedMcpConfig, McpServerConfigPatch } from "../src/config/files.ts";
import type { McpServerConfig } from "../src/config/schema.ts";
import { createMcpExtension, type McpExtensionOptions } from "../src/index.ts";
import type { McpToolDefinition } from "../src/tools/definition.ts";
import { TOOL_META_CHANNEL, type ToolMeta } from "../src/tools/meta.ts";

export const SCHEMA = { type: "object", properties: {} };

/** What an in-memory server offers. */
export interface FakeServer {
  tools?: readonly Record<string, unknown>[];
  resources?: readonly { uri: string; name: string; text: string }[];
  /** Text of every tool result. Default: `ok`. */
  callText?: string;
  /** Milliseconds before the server answers `initialize`. */
  initializeDelayMs?: number;
  /** The transport cannot be created, as when a command cannot be resolved. */
  failure?: string;
}

function serve(server: FakeServer) {
  const pair = createInMemoryTransportPair();
  const respond = (request: JsonRpcRequest): unknown => {
    switch (request.method) {
      case "initialize":
        return {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {}, ...(server.resources ? { resources: {} } : {}) },
          serverInfo: { name: "fake", version: "1.0.0" },
        };
      case "tools/list":
        return { tools: server.tools ?? [] };
      case "tools/call":
        return { content: [{ type: "text", text: server.callText ?? "ok" }] };
      case "resources/list":
        return { resources: (server.resources ?? []).map(({ uri, name }) => ({ uri, name })) };
      case "resources/read": {
        const { uri } = request.params as { uri: string };
        const resource = server.resources?.find((candidate) => candidate.uri === uri);
        return { contents: resource ? [{ uri, text: resource.text }] : [] };
      }
      default:
        return {};
    }
  };
  pair.server.onMessage((message) => {
    if (!("id" in message) || !("method" in message)) return;
    const request = message as JsonRpcRequest;
    const reply = () => {
      pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) }).catch(() => {});
    };
    const delayMs = request.method === "initialize" ? (server.initializeDelayMs ?? 0) : 0;
    if (delayMs > 0) setTimeout(reply, delayMs);
    else queueMicrotask(reply);
  });
  void pair.server.start();
  return pair;
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface StartOptions {
  config?: Partial<LoadedMcpConfig>;
  /** Servers extensions registered, by name. */
  registered?: Record<string, unknown>;
  /** What each server offers, by name. Default: the `docs` server offering `echo`. */
  servers?: Record<string, FakeServer>;
  startupWaitMs?: number;
  /** Loads the extension into pi. Default: `createMcpExtension(options)`. */
  install?: (pi: ExtensionAPI, options: McpExtensionOptions) => void;
}

/** Load the extension into a stand-in for the pi API, start a session, and wait like the first prompt. */
export async function startSession(options: StartOptions = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "pi-mcp-adapter-test-"));
  const tools = new Map<McpToolDefinition["name"], McpToolDefinition>();
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const notices: string[] = [];
  const events = createEventBus();
  /** Transports opened and closed, by server name. */
  const opened: string[] = [];
  const closed: string[] = [];
  /** Changes `/mcp` saved to config files. */
  const updates: { name: string; patch: McpServerConfigPatch }[] = [];
  let registered = options.registered ?? {};
  let active: string[] = [];
  const fakes = options.servers ?? { docs: { tools: [{ name: "echo", inputSchema: SCHEMA }] } };
  const pi = {
    events,
    registerToolRenderer: () => {},
    registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      commands.set(name, command);
    },
    registerTool: (definition: McpToolDefinition) => {
      tools.set(definition.name, definition);
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getMcpServers: () =>
      Object.entries(registered).map(([name, config]) => ({
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
  const install = options.install ?? ((api, extensionOptions) => createMcpExtension(extensionOptions)(api));
  install(pi, {
    loadConfig: () => config,
    createTransport: (entry) => {
      const fake = fakes[entry.name] ?? {};
      if (fake.failure) throw new Error(fake.failure);
      opened.push(entry.name);
      const pair = serve(fake);
      pair.server.onClose(() => closed.push(entry.name));
      return pair.client;
    },
    updateConfig: (entry, patch) => updates.push({ name: entry.name, patch }),
    logPath: join(logDir, "mcp.log"),
    startupWaitMs: options.startupWaitMs ?? 5_000,
  });

  /** Run the handlers of `event` in order, like pi does. */
  const emit = async (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const callResult = async (name: string, params: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} is not registered`);
    return tool.execute("call", params, undefined, undefined, ctx);
  };
  const call = async (name: string, params: Record<string, unknown> = {}) =>
    ((await callResult(name, params)).content[0] as TextContent).text;
  const command = async (args: string) => {
    const mcp = commands.get("mcp");
    if (!mcp) throw new Error("/mcp is not registered");
    await mcp.handler(args, ctx as unknown as Parameters<typeof mcp.handler>[1]);
  };
  const askToolMeta = () => {
    const replies: Record<string, ToolMeta>[] = [];
    events.emit(TOOL_META_CHANNEL, { reply: (meta: Record<string, ToolMeta>) => replies.push(meta) });
    return replies;
  };
  let isShutDown = false;
  const shutdown = async () => {
    if (!isShutDown) await emit("session_shutdown", {});
    isShutDown = true;
    rmSync(logDir, { recursive: true, force: true });
  };

  await emit("session_start", {});
  // The first prompt waits for servers with direct tools.
  await emit("before_agent_start", { systemPromptOptions: { sections: {} } });
  return {
    tools,
    notices,
    events,
    opened,
    closed,
    updates,
    setRegistered: (next: Record<string, unknown>) => {
      registered = next;
    },
    emit,
    call,
    callResult,
    command,
    askToolMeta,
    /** End the session like pi does; later calls only clean up. */
    endSession: async () => {
      await emit("session_shutdown", {});
      isShutDown = true;
    },
    shutdown,
  };
}

export type TestSession = Awaited<ReturnType<typeof startSession>>;
