/**
 * MCP server configuration: the `mcpServers` entries of `mcp.json` and of `pi.registerMcpServer()`,
 * their validation, and how they expose tools.
 *
 * Entries use the `mcpServers` shape shared by other MCP clients, so existing configurations can be
 * copied over:
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
 *     "sentry": { "url": "https://mcp.sentry.dev/mcp" }
 *   }
 * }
 * ```
 *
 * HTTP servers without an `Authorization` header use OAuth when they answer 401 (sign in with `/mcp`).
 * `"auth": { "provider": "<provider>" }` sends the token of a `/login` provider instead. Project files
 * cannot use it, so a repository cannot pick where the credential goes.
 *
 * Pi stores registered servers without validating the settings it does not know, so this extension
 * validates them again with {@link validateMcpServerConfig}.
 */

import type { ToolExposure } from "@earendil-works/pi-coding-agent";

/**
 * - `codemode`: tools are callable from codemode scripts but neither declared to the model nor
 *   listed in the codemode description, which lists only the server's namespace. Scripts find them
 *   with `searchTools()`. `codemode-deferred` is accepted as an alias.
 * - `deferred`: not declared to the model until the `tool_search` tool loads them; the model then
 *   calls them directly. Does not need codemode.
 * - `direct`: tools are declared to the model like any other tool (and callable from codemode).
 * - `hidden`: tools are registered but unreachable.
 */
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

/**
 * Tool exposure of an MCP exposure. `codemode` and `deferred` both leave tools out of the codemode
 * description; they differ only in which tool the MCP extension activates to reach them.
 */
export function toToolExposure(exposure: McpExposure): ToolExposure {
  return exposure === "codemode" ? "deferred" : exposure;
}

const MCP_EXPOSURES: readonly string[] = ["codemode", "deferred", "direct", "hidden"] satisfies McpExposure[];

/** Older exposure names, accepted in configs and replaced by their current name when validated. */
const MCP_EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = { "codemode-deferred": "codemode" };

interface McpServerConfigBase {
  /** Default: `codemode`. */
  exposure?: McpExposure;
  /**
   * What the server offers, in a sentence. The `mcp_servers` system prompt section lists the server
   * with it, tool search ranks the server's tools by it, and codemode's `describeNamespace()` returns it.
   */
  description?: string;
  /**
   * Exposure of single tools, overriding `exposure`. Keys are tool names as the server offers them,
   * or patterns where `*` matches any characters. An exact name wins over patterns; among patterns
   * the first match in the object wins. `hidden` removes tools, so `"exposure": "hidden"` with
   * overrides for a few tools exposes only those.
   */
  toolExposure?: Record<string, McpExposure>;
  /** Set to false to keep the entry without connecting. Default: true. */
  enabled?: boolean;
  /** Per-request timeout in seconds. Progress notifications from the server reset it. Default: 60. */
  timeout?: number;
  /**
   * Bytes of model-facing text of the server's tool results and resource reads; longer text is cut in
   * the middle. A tool's `pi/maxOutputBytes` `_meta` takes precedence. Default: the top-level
   * `maxOutputBytes` of `mcp.json`, else 20 KiB.
   */
  maxOutputBytes?: number;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  type?: "stdio";
  command: string;
  args?: string[];
  /** Values may reference environment variables (`${NAME}`) or commands (`!cmd`). */
  env?: Record<string, string>;
  /** Relative paths resolve against the session working directory. */
  cwd?: string;
}

/** OAuth client settings for servers that do not support dynamic client registration. */
export interface McpOAuthConfig {
  /** Pre-registered client id. Without it, pi registers a client with the authorization server. */
  clientId?: string;
  /** May reference environment variables (`${NAME}`) or commands (`!cmd`). */
  clientSecret?: string;
  /**
   * Port of the loopback callback server, for clients registered with a fixed redirect URI. Without
   * `callbackUrl`, the redirect URI is `http://127.0.0.1:<port>/callback`.
   */
  callbackPort?: number;
  /**
   * Redirect URI registered for `clientId`, for example `http://localhost:8080/oauth/callback`. It must
   * be an `http` URI on `localhost`, `127.0.0.1`, or `[::1]`. Without a port, the callback server
   * listens on `callbackPort` or a free port, which is added to the URI (RFC 8252).
   */
  callbackUrl?: string;
  /** Scopes to request, separated by spaces. Default: the scopes the server advertises. */
  scope?: string;
  /**
   * `client_name` sent with dynamic client registration, for servers that only accept known clients.
   * Default: `pi`.
   */
  clientName?: string;
  /**
   * How pi identifies itself without `clientId`. `dcr` (default): dynamic client registration. `cimd`:
   * pi's Client ID Metadata Document on pi.dev, for authorization servers that allow pi by that URL. The
   * server must support it for public clients, and the callback must use the default path `/callback`.
   */
  clientRegistration?: "dcr" | "cimd";
  /**
   * Authorization server metadata document (RFC 8414 or OpenID Connect discovery) to use instead of
   * discovery through the server, for servers that advertise a wrong authorization server or none.
   * The document is trusted as configured. Must use https, except on loopback hosts.
   */
  authServerMetadataUrl?: string;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Whether a redirect URI can be served by pi's loopback callback server. */
function isLoopbackRedirectUri(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname) && url.search === "" && url.hash === "";
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  type?: "http";
  url: string;
  /** Values may reference environment variables (`${NAME}`) or commands (`!cmd`). */
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  /**
   * Send the token of a pi provider (`/login <provider>`) instead of using OAuth. Not allowed in project
   * `mcp.json` files, and requires https except on loopback hosts, since it sends the credential to `url`.
   */
  auth?: { provider: string };
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** Namespace of a server's tools: `mcp__<server>` with `-` replaced by `_`, like the tool names. */
export function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, "_")}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function validateOAuth(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "oauth must be an object";
  if (value.clientId !== undefined && typeof value.clientId !== "string") return "oauth.clientId must be a string";
  if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") {
    return "oauth.clientSecret must be a string";
  }
  const port = value.callbackPort;
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
    return "oauth.callbackPort must be a port number";
  }
  if (value.callbackUrl !== undefined) {
    if (typeof value.callbackUrl !== "string" || !isLoopbackRedirectUri(value.callbackUrl)) {
      return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
    }
    const urlPort = new URL(value.callbackUrl).port;
    if (urlPort && port !== undefined && Number(urlPort) !== port) {
      return "oauth.callbackUrl and oauth.callbackPort name different ports";
    }
  }
  if (value.scope !== undefined && typeof value.scope !== "string") return "oauth.scope must be a string";
  if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim())) {
    return "oauth.clientName must be a non-empty string";
  }
  if (value.clientRegistration !== undefined && value.clientRegistration !== "dcr") {
    if (value.clientRegistration !== "cimd") return 'oauth.clientRegistration must be "dcr" or "cimd"';
    if (value.clientId !== undefined || value.clientName !== undefined) {
      return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
    }
    const callback = typeof value.callbackUrl === "string" ? new URL(value.callbackUrl) : undefined;
    if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) {
      return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
    }
  }
  const metadataUrl = value.authServerMetadataUrl;
  if (metadataUrl !== undefined) {
    const url = typeof metadataUrl === "string" && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
    if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) {
      return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
    }
  }
  return undefined;
}

/** Whether a value is a valid `maxOutputBytes`: a positive integer. */
export function isMaxOutputBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isExposure(value: unknown): value is McpExposure {
  return typeof value === "string" && MCP_EXPOSURES.includes(value);
}

/** The exposure an alias stands for; other values are returned unchanged. */
function resolveExposureAlias(value: unknown): unknown {
  return typeof value === "string" ? (MCP_EXPOSURE_ALIASES[value] ?? value) : value;
}

/** A copy of the server entry with exposure aliases replaced by their current names. */
function resolveExposureAliases(value: Record<string, unknown>): Record<string, unknown> {
  const { exposure, toolExposure } = value;
  const resolved: Record<string, unknown> = { ...value };
  if (exposure !== undefined) resolved.exposure = resolveExposureAlias(exposure);
  if (isRecord(toolExposure)) {
    resolved.toolExposure = Object.fromEntries(
      Object.entries(toolExposure).map(([tool, entry]) => [tool, resolveExposureAlias(entry)]),
    );
  }
  return resolved;
}

/**
 * Regular expression for a tool name pattern where `*` matches any characters, as `toolExposure`
 * accepts them.
 */
function toolPatternRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/** Exposure of one tool of a server: its `toolExposure` entry, else the server's `exposure`. */
export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
  const overrides = config.toolExposure ?? {};
  const exact = overrides[toolName];
  if (exact !== undefined) return exact;
  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
  }
  return config.exposure ?? "codemode";
}

/**
 * Validate one server entry of the `mcpServers` shape. Returns a copy of the config with exposure
 * aliases resolved, or an error message.
 */
export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
  if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
  if (!isRecord(raw)) return `server "${name}" must be an object`;
  const value = resolveExposureAliases(raw);
  const { type, exposure, enabled, timeout, toolExposure, description, maxOutputBytes } = value;
  const exposures = MCP_EXPOSURES.map((value) => `"${value}"`).join(", ");
  if (exposure !== undefined && !isExposure(exposure)) {
    return `server "${name}": exposure must be one of ${exposures}`;
  }
  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
    for (const [tool, value] of Object.entries(toolExposure)) {
      if (!isExposure(value)) return `server "${name}": toolExposure "${tool}" must be one of ${exposures}`;
    }
  }
  if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
  if (description !== undefined && typeof description !== "string") {
    return `server "${name}": description must be a string`;
  }
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
    return `server "${name}": timeout must be a positive number of seconds`;
  }
  if (maxOutputBytes !== undefined && !isMaxOutputBytes(maxOutputBytes)) {
    return `server "${name}": maxOutputBytes must be a positive integer`;
  }
  if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;

  if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
    if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) {
      return `server "${name}": url must be an http or https URL`;
    }
    if (value.headers !== undefined && !isStringRecord(value.headers)) {
      return `server "${name}": headers must map names to strings`;
    }
    const oauthError = validateOAuth(value.oauth);
    if (oauthError) return `server "${name}": ${oauthError}`;
    if (value.auth !== undefined) {
      if (!isRecord(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider) {
        return `server "${name}": auth.provider must be a provider name`;
      }
      const url = new URL(value.url);
      if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
        return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
      }
    }
    return value as unknown as McpHttpServerConfig;
  }
  if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
    if (
      value.args !== undefined &&
      !(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
    ) {
      return `server "${name}": args must be an array of strings`;
    }
    if (value.env !== undefined && !isStringRecord(value.env)) return `server "${name}": env must map names to strings`;
    if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
    return value as unknown as McpStdioServerConfig;
  }
  return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  /** Config file that defined the entry, or the path of the extension that registered it. */
  source: string;
  /**
   * The global or the project `mcp.json`, or `extension` for servers registered with
   * `pi.registerMcpServer()`. Changes to extension servers are not saved.
   */
  scope?: "global" | "project" | "extension";
  /** Project `mcp.json` with an override of this global server's `enabled`, `exposure`, or `toolExposure`. */
  override?: string;
}
