/** Transports to MCP servers: a stdio child process or streamable HTTP, built from the server config. */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AuthProvider, type McpTransport, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import type { McpServerEntry } from "../config/schema.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../config/values.ts";

export type McpTransportFactory = (
  entry: McpServerEntry,
  cwd: string,
  authProvider: AuthProvider | undefined,
) => McpTransport;

/** `~` and `~/…` (also `~\…` on Windows) name the home directory, like in a shell. */
function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

/** Throws when a header or environment value cannot be resolved. */
export function createDefaultTransport(
  entry: McpServerEntry,
  cwd: string,
  authProvider: AuthProvider | undefined,
): McpTransport {
  const { config, name } = entry;
  if ("url" in config) {
    return new StreamableHttpTransport({
      url: config.url,
      headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
      authProvider,
    });
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.env ?? {})) {
    env[key] = resolveConfigValueOrThrow(value, `MCP server "${name}" env "${key}"`);
  }
  return new StdioTransport({
    command: expandHome(config.command),
    args: config.args?.map(expandHome),
    cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
    env,
    stderr: "pipe",
  });
}
