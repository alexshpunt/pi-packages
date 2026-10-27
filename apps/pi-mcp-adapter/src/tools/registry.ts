/**
 * The pi tools of MCP servers. Tools are registered as `mcp__<server>__<tool>`, under names that stay
 * unique across servers and stable across reconnects. Pi cannot unregister tools, so tools a server no
 * longer offers, and the tools of disabled servers, stay registered as hidden.
 */

import { createHash } from "node:crypto";
import type { ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Tool as McpTool } from "@earendil-works/pi-mcp";
import { Context, Effect, Layer } from "effect";
import type { TSchema } from "typebox";
import { getMcpToolExposure, type McpExposure, type McpServerConfig, mcpNamespace } from "../config/schema.ts";
import { createMcpToolDefinition, type McpToolDefinition, type ToolTarget } from "./definition.ts";
import type { McpToolDetails } from "./output.ts";
import { createMcpResourceToolDefinitions, type McpResourceServer } from "./resources.ts";

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_CHARS = 64;

/**
 * `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when too long. Like Codex,
 * everything but `[A-Za-z0-9_]` becomes `_`, so the name is also the identifier codemode scripts
 * call it by. `isTaken` reports names used by a different MCP tool: sanitizing can map two tools to
 * one name (`a-b` and `a_b`), which then get the hash suffix.
 */
function createMcpToolName(server: string, tool: string, isTaken: (name: string) => boolean = () => false): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length <= MAX_TOOL_NAME_CHARS && !isTaken(name)) return name;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME_CHARS - hash.length - 1)}_${hash}`;
}

/** Pi's tool registry, as far as MCP tools use it. */
export interface ToolHostShape {
  readonly registerTool: (definition: ToolDefinition<TSchema, McpToolDetails>) => Effect.Effect<void>;
  readonly allTools: Effect.Effect<readonly ToolInfo[]>;
  /** The tools declared to the model. */
  readonly activeTools: Effect.Effect<readonly string[]>;
  readonly setActiveTools: (names: readonly string[]) => Effect.Effect<void>;
}

export class ToolHost extends Context.Service<ToolHost, ToolHostShape>()("pi-mcp-adapter/ToolHost") {}

/** The tools a connected server offers. */
export interface ServerTools {
  readonly server: string;
  /** The server's current config, which sets each tool's exposure and the namespace description. */
  readonly config: McpServerConfig;
  readonly tools: readonly McpTool[];
  readonly instructions: string | undefined;
  readonly timeoutMs: number;
  readonly target: ToolTarget;
}

/** The servers the resource tools reach. */
export interface ResourceServers {
  readonly exposures: ReadonlySet<McpExposure>;
  /** Read when a call runs. */
  readonly servers: () => readonly McpResourceServer[];
  /** The configured `maxOutputBytes` of results about one server, or about every server without one. */
  readonly maxOutputBytes: (server: string | undefined) => number | undefined;
}

export interface ToolRegistryShape {
  /** Register the server's tools. Tools it registered before and no longer offers become hidden. */
  readonly registerServerTools: (offered: ServerTools) => Effect.Effect<void>;
  /** Make a disabled server's tools unreachable. */
  readonly hideServerTools: (server: string) => Effect.Effect<void>;
  /**
   * Register the resource tools with the widest exposure of the servers they reach: `direct` when
   * one of them is direct, and so on. They are hidden when no server has resources.
   */
  readonly syncResourceTools: (reached: ResourceServers) => Effect.Effect<void>;
  /** Remove the server's tools that are no longer `direct` from the tools declared to the model. */
  readonly deactivateIndirectTools: (server: string) => Effect.Effect<void>;
  /** The server whose tool pi has under `toolName`. */
  readonly serverOf: (toolName: string) => Effect.Effect<string | undefined>;
  /** The last definition registered under each tool name. */
  readonly definitions: Effect.Effect<readonly McpToolDefinition[]>;
}

export class ToolRegistry extends Context.Service<ToolRegistry, ToolRegistryShape>()("pi-mcp-adapter/ToolRegistry") {}

export const ToolRegistryLive = Layer.effect(
  ToolRegistry,
  Effect.gen(function* () {
    const host = yield* ToolHost;
    /** pi tool name to the `<server>\0<tool>` it was assigned to, so names stay unique and stable. */
    const toolOwners = new Map<string, string>();
    /** Tool names currently offered by each server. */
    const serverTools = new Map<string, Set<string>>();
    /** Last definition registered under each tool name, to re-register withdrawn tools as hidden. */
    const definitions = new Map<string, McpToolDefinition>();
    /** Exposure the resource tools were last registered with; undefined until a server has resources. */
    let resourceToolsExposure: McpExposure | undefined;

    const hideTools = (names: Iterable<string>, isKept: (name: string) => boolean = () => false) =>
      Effect.forEach(
        [...names].filter((name) => !isKept(name)),
        (name) => {
          const definition = definitions.get(name);
          return definition ? host.registerTool({ ...definition, exposure: "hidden" }) : Effect.void;
        },
        { discard: true },
      );

    return {
      registerServerTools: ({ server, config, tools, instructions, timeoutMs, target }) =>
        Effect.gen(function* () {
          const description = config.description?.trim();
          const namespace = {
            name: mcpNamespace(server),
            // `describeNamespace("docs")` finds `mcp__docs`.
            aliases: [server],
            ...(description ? { description } : {}),
            ...(instructions ? { instructions } : {}),
          };
          const previous = serverTools.get(server) ?? new Set<string>();
          const current = new Set<string>();
          // Like Codex, all tools whose names sanitize to the same name get the hash suffix, so which
          // one would keep the plain name does not depend on the order of the list.
          const plain = [...new Set(tools.map((tool) => tool.name))].map((tool) => createMcpToolName(server, tool));
          const assignName = (tool: string, owner: string) => {
            const name = createMcpToolName(server, tool, (candidate) => {
              const existing = toolOwners.get(candidate);
              return (
                (existing !== undefined && existing !== owner) ||
                current.has(candidate) ||
                plain.indexOf(candidate) !== plain.lastIndexOf(candidate)
              );
            });
            toolOwners.set(name, owner);
            current.add(name);
            return name;
          };
          for (const tool of tools) {
            const definition = createMcpToolDefinition({
              server,
              tool,
              name: assignName(tool.name, `${server}\0${tool.name}`),
              exposure: getMcpToolExposure(config, tool.name),
              namespace,
              timeoutMs,
              target,
            });
            definitions.set(definition.name, definition);
            yield* host.registerTool(definition);
          }
          serverTools.set(server, current);
          // When the server offers dropped tools again they are registered with their configured exposure above.
          yield* hideTools(previous, (name) => current.has(name));
        }),

      hideServerTools: (server) =>
        Effect.suspend(() => {
          const names = serverTools.get(server) ?? [];
          serverTools.set(server, new Set());
          return hideTools(names);
        }),

      syncResourceTools: ({ exposures, servers, maxOutputBytes }) =>
        Effect.gen(function* () {
          const exposure = (["direct", "codemode", "deferred"] as const).find((candidate) => exposures.has(candidate));
          const next = exposure ?? "hidden";
          if (next === resourceToolsExposure || (resourceToolsExposure === undefined && next === "hidden")) return;
          const wasDirect = resourceToolsExposure === "direct";
          resourceToolsExposure = next;
          const resourceDefinitions = createMcpResourceToolDefinitions({ exposure: next, servers, maxOutputBytes });
          for (const definition of resourceDefinitions) yield* host.registerTool(definition);
          if (wasDirect) {
            const names = new Set(resourceDefinitions.map((definition) => definition.name));
            const active = yield* host.activeTools;
            yield* host.setActiveTools(active.filter((name) => !names.has(name)));
          }
        }),

      deactivateIndirectTools: (server) =>
        Effect.gen(function* () {
          const indirect = new Set(
            (yield* host.allTools).filter((tool) => tool.exposure !== "direct").map((tool) => tool.name),
          );
          const tools = serverTools.get(server) ?? new Set<string>();
          const active = yield* host.activeTools;
          yield* host.setActiveTools(active.filter((name) => !tools.has(name) || !indirect.has(name)));
        }),

      serverOf: (toolName) => Effect.sync(() => toolOwners.get(toolName)?.split("\0", 1)[0]),

      definitions: Effect.sync(() => [...definitions.values()]),
    } satisfies ToolRegistryShape;
  }),
);
