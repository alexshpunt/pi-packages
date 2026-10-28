# pi-mcp-adapter

**English** | [한국어](README.ko.md)

Connects [MCP](https://modelcontextprotocol.io) servers to [Pi](https://github.com/earendil-works/pi). It replaces Pi's built-in MCP support and works the same way: it reads the same `mcp.json`, offers the same `/mcp` manager, and exposes tools the same ways. It adds two things:

- **Output limit you can set.** Pi cuts long MCP results at 20 KB. Here a tool, a server, or `mcp.json` can set another limit (see [Limit tool output](#limit-tool-output)).
- **Tool `_meta` for other extensions.** Each MCP tool keeps the `_meta` its server declares, and other extensions can read it (see [Read tool `_meta` from another extension](#read-tool-_meta-from-another-extension)).

## Requirements

- Node.js 22.19.0 or later.
- Pi 1.4.0 (tested with 1.4.0).

## Installation

Install from npm:

```bash
pi install npm:@buyong/pi-mcp-adapter
```

To install from a checkout instead, install its dependencies first; Pi does not install dependencies for local packages:

```bash
cd /path/to/pi-packages
pnpm install
pi install /path/to/pi-packages/apps/pi-mcp-adapter
```

Then turn off Pi's built-in MCP support, so that only this extension reads `mcp.json`. Add `-builtin:mcp` to `extensions` in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["-builtin:mcp"]
}
```

You can also turn off `mcp` under **Built-in** in `pi config`. The adapter takes over either way, but while the built-in support is on, Pi prints this warning at every start:

```text
Warning: Extension package "builtin:mcp": Extension <path>/src/index.ts registers command `/mcp`, so built-in extension `mcp` was not loaded. …
```

Restart Pi, or run `/reload` in a running Pi. If you installed from a checkout, keep it in place: Pi loads a local package from its directory instead of copying it.

To try the package for one session without installing it, start Pi with `pi -e /path/to/pi-packages/apps/pi-mcp-adapter`.

## Configure servers

Servers are read from `~/.pi/agent/mcp.json` and, in a trusted project, from `.pi/mcp.json`. A project entry replaces the global entry of the same name. A project entry without `command`, `url`, or `type` changes only `enabled`, `exposure`, and `toolExposure` of the global entry and keeps the rest. The format is the `mcpServers` shape other MCP clients use:

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
  }
}
```

Every setting of Pi's built-in MCP support works the same way. See [Pi's MCP documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) for the details.

| Setting | Where | Meaning |
| --- | --- | --- |
| `command`, `args`, `env`, `cwd` | server | A stdio server. |
| `url`, `headers`, `oauth`, `auth` | server | A streamable HTTP server and how it signs in. |
| `exposure`, `toolExposure` | server | How tools reach the model: `codemode` (default), `deferred`, `direct`, or `hidden`. |
| `description` | server | What the server offers, in a sentence. |
| `enabled` | server | `false` keeps the entry without connecting. |
| `timeout` | server | Seconds per request (default 60). |
| `maxOutputBytes` | server, top level | Output limit in bytes (see [Limit tool output](#limit-tool-output)). |
| `autoEnableCodemode` | top level | `false` stops the adapter from turning on the `codemode` tool. |

Servers that extensions register with `pi.registerMcpServer()` connect too. A server in `mcp.json` takes precedence over a registered one with the same name.

## Limit tool output

When the text of a tool result is longer than the limit, the model gets its start and end with a `…N chars truncated…` marker in the middle. The full text is saved to a temporary file, and the result names that file. The limit, in bytes, is the first of these that is set:

1. `_meta["pi/maxOutputBytes"]` in the tool's `tools/list` entry, set by the server.
2. `maxOutputBytes` in the server's entry.
3. `maxOutputBytes` at the top level of `mcp.json`. A project value replaces the global one.
4. Otherwise, 20 KB (20480 bytes).

```json
{
  "maxOutputBytes": 51200,
  "mcpServers": {
    "docs": { "url": "https://example.com/mcp", "maxOutputBytes": 204800 }
  }
}
```

A server declares its own limit for a tool like this:

```json
{ "name": "dump_schema", "inputSchema": { "type": "object" }, "_meta": { "pi/maxOutputBytes": 200000 } }
```

Each value must be a positive integer:

- An invalid value in `mcp.json` is a config error. Pi reports it at startup and in `/mcp`. An invalid server is not connected; an invalid top-level value is ignored.
- A server that an extension registers with an invalid `maxOutputBytes` is reported the same way and not connected.
- An invalid `pi/maxOutputBytes` in a tool's `_meta` is ignored, and steps 2 to 4 apply.

The resource tools use steps 2 to 4: `read_mcp_resource`, and `list_mcp_resources` and `list_mcp_resource_templates` called with a `server`. Called without a `server`, the two listing tools use steps 3 and 4. Codemode scripts always receive the complete result.

## Read tool `_meta` from another extension

Each MCP tool keeps the `_meta` object of its `tools/list` entry, as the server sent it. It is never sent to the model. Pi 1.4.0's `pi.getAllTools()` does not report it, so the adapter answers requests on the `tool-meta` channel of `pi.events`:

```ts
const meta: Record<string, Record<string, unknown>> = {};
pi.events.emit("tool-meta", { reply: (tools) => Object.assign(meta, tools) });
// meta["mcp__docs__search"] is the `_meta` of the tool `search` of the server `docs`.
```

- The adapter calls `reply` before `emit` returns.
- The keys are Pi tool names (`mcp__<server>__<tool>`), including tools that are not active.
- Only tools whose `_meta` is an object are listed. The resource tools have none.
- Each reply has its own copies, so changing them does not change the adapter's.
- Other extensions may also answer the channel. Each one calls `reply` with its own tools, so merge the replies.

Each tool's definition also carries the same object as `meta`. A Pi version that reports `meta` in `pi.getAllTools()` lists it there too.

## Manage servers

- `/mcp` opens a manager. It lists the servers with their state and tools, and lets you sign in, sign out, reconnect, enable or disable a server, and change its exposure.
- Enabling, disabling, and exposure changes are saved to the `mcp.json` that defines the server. **Enable in this project** and **Disable in this project** save to the project's `.pi/mcp.json`. For a server an extension registered, the changes last only for the session.
- `/mcp login [server]`, `/mcp logout [server]`, and `/mcp reconnect [server]` sign in, sign out, and reconnect without opening the manager.
- Outside the interactive TUI, `/mcp` prints the server status.

OAuth credentials are stored in `~/.pi/agent/mcp-auth.json`, the same file Pi uses. Server log messages are appended to `~/.pi/agent/mcp.log`.

## Differences from Pi's built-in MCP support

- The output limit and the tool `_meta` above.
- `pi mcp` shell commands (`pi mcp add`, `pi mcp login`, and so on) still run Pi's built-in implementation. They read and write the same `mcp.json` and `mcp-auth.json`, so the adapter sees their changes.
- Config values that run a command (`"!command"` in `env`, `headers`, or `oauth.clientSecret`) run in the system default shell. On Windows this is `cmd.exe`, not the shell configured in Pi. The command runs again on every connection, while Pi runs it once per process.

## Development and verification

Run these from `apps/pi-mcp-adapter` after `pnpm install` at the repository root:

```bash
pnpm run typecheck
pnpm run lint
pnpm run test:unit
```

`test:unit` runs the extension against in-memory MCP servers. It checks the limit order, the config validation, the `tool-meta` channel, and the server connections from startup through `/mcp` actions to shutdown.

To check it in Pi by hand, add a server to `~/.pi/agent/mcp.json`, start `pi -e /path/to/pi-packages/apps/pi-mcp-adapter`, and run `/mcp`. The manager lists the server as `connected` with its tool count.

## License

MIT. See [`LICENSE`](LICENSE). The code is derived from Pi's built-in MCP extension, which is also under the MIT License.
