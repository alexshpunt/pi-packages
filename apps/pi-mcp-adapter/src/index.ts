/**
 * MCP integration. It registers `/mcp`, so it replaces pi's built-in MCP support for sessions: pi then
 * leaves `mcp.json` and registered servers to this extension. `pi mcp` shell commands still run pi's
 * own implementation.
 *
 * Connects the servers from `mcp.json` and the servers extensions register with
 * `pi.registerMcpServer()` when a session starts, and servers registered later right away. A server
 * in `mcp.json` takes precedence over a registered server of the same name. Connections run in the
 * background: the first prompt waits only for servers with `direct` tools, and codemode scripts,
 * `tool_search`, and the resource tools wait for the servers they need when they run. Tools are
 * registered as `mcp__<server>__<tool>`. By default (`"exposure": "codemode"`) the tools are only
 * callable from codemode scripts, which keeps MCP tools out of the model's tool declarations and
 * the codemode description: scripts find the tools with `searchTools()` and the server instructions
 * with `describeNamespace()`. The codemode tool is activated for that unless `autoEnableCodemode` is
 * false. `"deferred"` declares the tools to the model once the `tool_search` tool loads them, and
 * activates `tool_search` instead of codemode.
 * `"exposure": "direct"` declares them to the model right away, and `"hidden"` makes them
 * unreachable. `toolExposure` overrides the exposure of single tools. Servers with resources are
 * reached through Codex's `list_mcp_resources`, `list_mcp_resource_templates`, and
 * `read_mcp_resource` tools (tools/resources.ts).
 *
 * Every call runs through pi's tool pipeline, so `tool_call`/`tool_result` hooks and permission
 * extensions apply to MCP tools the same way they do to built-in tools.
 *
 * The model-facing text of a result is limited to the tool's `pi/maxOutputBytes` `_meta`, else the
 * configured `maxOutputBytes` (tools/output.ts). Other extensions read each tool's `_meta` through
 * `pi.events` (tools/meta.ts).
 *
 * Problems found at startup (config errors, failed connections, servers that need a sign-in) are
 * reported once. `/mcp` opens a manager to sign in, reconnect, enable or disable servers, and change
 * their exposure; the last two are saved to the `mcp.json` that defines the server, or apply to the
 * current session for registered servers.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { buildMcpServices } from "./app/layer.ts";
import { type McpExtensionOptions, resolveMcpExtensionOptions } from "./app/options.ts";
import { registerMcpExtension } from "./pi/registration.ts";

export type { McpExtensionOptions } from "./app/options.ts";
export type { McpTransportFactory } from "./servers/transport.ts";

export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
  return (pi) => {
    const resolved = resolveMcpExtensionOptions(options);
    registerMcpExtension(pi, buildMcpServices(pi, resolved), resolved);
  };
}

export default createMcpExtension();
