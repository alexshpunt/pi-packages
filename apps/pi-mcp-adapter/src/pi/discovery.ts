/**
 * Tools that are not declared to the model are reached through the codemode tool (scripts call them)
 * or the tool_search tool (it declares them). Either reaches every such tool. This activates the one
 * the configured exposures ask for: codemode for `codemode` unless `autoEnableCodemode` is false,
 * tool_search for `deferred`.
 */

import { Context, Effect, Layer } from "effect";
import type { McpExposure } from "../config/schema.ts";
import { configuredExposures, isEnabled } from "../servers/server.ts";
import { Servers } from "../servers/service.ts";
import { ToolHost } from "../tools/registry.ts";

/** pi's tools that reach tools not declared to the model. */
const CODEMODE_TOOL_NAME = "codemode";
const TOOL_SEARCH_TOOL_NAME = "tool_search";

export interface DiscoveryShape {
  /** Start a session, which may warn again. */
  readonly reset: Effect.Effect<void>;
  /**
   * Activate the tools the enabled servers' exposures need, from the config, so they are active before
   * the servers connect. `warn` gets a warning, once per session, when neither tool is active.
   */
  readonly ensureActive: (warn: (message: string) => void) => Effect.Effect<void>;
}

export class Discovery extends Context.Service<Discovery, DiscoveryShape>()("pi-mcp-adapter/Discovery") {}

export const DiscoveryLive = Layer.effect(
  Discovery,
  Effect.gen(function* () {
    const host = yield* ToolHost;
    const servers = yield* Servers;
    /** Whether the "codemode tools unreachable" warning was shown since the session started. */
    let hasWarnedUnreachable = false;
    return {
      reset: Effect.sync(() => {
        hasWarnedUnreachable = false;
      }),
      ensureActive: (warn) =>
        Effect.gen(function* () {
          // Resource tools share their server's exposure.
          const exposures = new Set<McpExposure>();
          for (const server of yield* servers.list) {
            if (isEnabled(server)) for (const exposure of configuredExposures(server.entry)) exposures.add(exposure);
          }
          const needsCodemode = exposures.has("codemode");
          const needsToolSearch = exposures.has("deferred");
          if (!needsCodemode && !needsToolSearch) return;
          // Only a tool of these names that declares `reachesTools` can reach MCP tools; another
          // extension's tool of the same name without it is never activated.
          const tools = yield* host.allTools;
          const hasReachingTool = (name: string) => tools.some((tool) => tool.name === name && tool.reachesTools);
          const hasCodemode = hasReachingTool(CODEMODE_TOOL_NAME);
          const hasToolSearch = hasReachingTool(TOOL_SEARCH_TOOL_NAME);
          const active = yield* host.activeTools;
          const autoEnableCodemode = yield* servers.autoEnableCodemode;
          const activate: string[] = [];
          if (needsCodemode && hasCodemode && autoEnableCodemode && !active.includes(CODEMODE_TOOL_NAME)) {
            activate.push(CODEMODE_TOOL_NAME);
          }
          if (needsToolSearch && hasToolSearch && !active.includes(TOOL_SEARCH_TOOL_NAME)) {
            activate.push(TOOL_SEARCH_TOOL_NAME);
          }
          if (activate.length > 0) yield* host.setActiveTools([...active, ...activate]);
          const reachable = [...active, ...activate];
          if (hasCodemode && reachable.includes(CODEMODE_TOOL_NAME)) return;
          if (hasToolSearch && reachable.includes(TOOL_SEARCH_TOOL_NAME)) return;
          if (hasWarnedUnreachable) return;
          hasWarnedUnreachable = true;
          const reason = needsCodemode && hasCodemode && !autoEnableCodemode ? " (autoEnableCodemode is false)" : "";
          warn(
            `MCP tools are only reachable from the codemode or tool_search tool, but neither is active${reason}; they cannot be called.`,
          );
        }),
    } satisfies DiscoveryShape;
  }),
);
