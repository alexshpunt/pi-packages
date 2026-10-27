/** How a server's state reads in `/mcp`, its completions, and the startup report. */

import { isEnabled, type McpServer } from "../servers/server.ts";

export function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

/** Short state for lists and the startup report. `shouldShowError` appends the first line of a failure. */
export function describeState(server: McpServer, shouldShowError = true): string {
  if (!isEnabled(server)) return "disabled";
  const connection = server.connection;
  if (!connection) return "starting";
  switch (connection.state) {
    case "needs-auth":
      return "needs sign-in";
    case "failed":
      return shouldShowError ? `failed: ${firstLine(connection.error ?? "unknown error")}` : "failed";
    case "connected": {
      const { tools, hasResources } = connection;
      return `connected · ${tools.length} tool${tools.length === 1 ? "" : "s"}${hasResources ? " · resources" : ""}`;
    }
    case "connecting":
      return "connecting…";
    default:
      return connection.state;
  }
}
