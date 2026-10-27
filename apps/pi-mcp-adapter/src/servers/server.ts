/** A configured server as other features see it, and what its config says about its tools. */

import { type McpExposure, type McpServerEntry, mcpNamespace } from "../config/schema.ts";
import type { McpServerConnection } from "./connection.ts";

/** A configured server. Disabled servers have no connection. Only the servers service changes it. */
export interface McpServer {
  readonly entry: McpServerEntry;
  readonly connection?: McpServerConnection;
}

export function isEnabled(server: Pick<McpServer, "entry">): boolean {
  return server.entry.config.enabled !== false;
}

export function exposureOf(entry: McpServerEntry): McpExposure {
  return entry.config.exposure ?? "codemode";
}

/** Exposures the server's tools can have, known from its config before it connects. */
export function configuredExposures(entry: McpServerEntry): Set<McpExposure> {
  return new Set([exposureOf(entry), ...Object.values(entry.config.toolExposure ?? {})]);
}

/** Whether some of the server's tools are declared to the model, so the first prompt waits for them. */
export function hasDirectTools(entry: McpServerEntry): boolean {
  return configuredExposures(entry).has("direct");
}

/** Whether some of the server's tools are reached through codemode or tool_search. */
export function hasIndirectTools(entry: McpServerEntry): boolean {
  const exposures = configuredExposures(entry);
  return exposures.has("codemode") || exposures.has("deferred");
}

/**
 * Whether a call that reaches `reach` (see `ToolDefinition.reachesTools`) needs the server: it
 * reaches every tool, or one of its words contains the server's namespace.
 */
export function reachesServer(reach: "all" | readonly string[], server: string): boolean {
  if (reach === "all") return true;
  const namespace = mcpNamespace(server);
  return reach.some((word) => word.includes(namespace));
}
