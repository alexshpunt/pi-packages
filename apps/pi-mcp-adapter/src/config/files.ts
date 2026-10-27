/**
 * The `mcp.json` files.
 *
 * Servers are read from `mcp.json` in the agent directory and, for trusted projects, from
 * `<project>/.pi/mcp.json`. Project entries replace global entries with the same name.
 *
 * A project entry without `command`, `url`, or `type` overrides only `enabled`, `exposure`, and
 * `toolExposure` of the global server with the same name, for example to turn it off in one project:
 * `{ "mcpServers": { "internal-tools": { "enabled": false } } }`. The rest of the global entry is kept,
 * including credentials the project could not set itself.
 *
 * The top-level `autoEnableCodemode` (default true) activates the codemode tool when a server
 * with `codemode` exposure connects. The top-level `maxOutputBytes` (default 20 KiB) limits the
 * model-facing text of results from servers without their own `maxOutputBytes`. A project value of
 * either overrides the global one.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  isMaxOutputBytes,
  isRecord,
  type McpExposure,
  type McpServerEntry,
  mcpNamespace,
  validateMcpServerConfig,
} from "./schema.ts";

export interface LoadedMcpConfig {
  servers: McpServerEntry[];
  /** Activate the codemode tool when `codemode` servers connect. Default: true. */
  autoEnableCodemode?: boolean;
  /** Bytes of model-facing text of results from servers without their own `maxOutputBytes`. */
  maxOutputBytes?: number;
  errors: string[];
  /** The project `mcp.json` when the project is trusted, where `/mcp` saves project overrides. */
  projectConfig?: string;
}

const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

/** Whether an entry overrides a server defined elsewhere instead of defining one. */
function isOverrideEntry(value: Record<string, unknown>): boolean {
  return value.command === undefined && value.url === undefined && value.type === undefined;
}

/** Remove a leading UTF-8 byte order mark from decoded text. */
function stripBom(content: string): string {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

interface McpConfigState {
  servers: Map<string, McpServerEntry>;
  autoEnableCodemode?: boolean;
  maxOutputBytes?: number;
  errors: string[];
}

function readConfigFile(path: string, scope: "global" | "project", state: McpConfigState): void {
  const { servers, errors } = state;
  if (!existsSync(path)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
  } catch (error) {
    errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    errors.push(`${path}: expected an object with an "mcpServers" object`);
    return;
  }
  if (typeof parsed.autoEnableCodemode === "boolean") state.autoEnableCodemode = parsed.autoEnableCodemode;
  else if (parsed.autoEnableCodemode !== undefined) errors.push(`${path}: autoEnableCodemode must be a boolean`);
  if (isMaxOutputBytes(parsed.maxOutputBytes)) state.maxOutputBytes = parsed.maxOutputBytes;
  else if (parsed.maxOutputBytes !== undefined) errors.push(`${path}: maxOutputBytes must be a positive integer`);
  for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
    if (scope === "project" && isRecord(value) && isOverrideEntry(value)) {
      const base = servers.get(name);
      const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.includes(key));
      if (!base) {
        errors.push(`${path}: server "${name}" needs "command" or "url", or a global server to override`);
      } else if (extra.length > 0) {
        errors.push(`${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`);
      } else {
        const config = validateMcpServerConfig(name, { ...base.config, ...value });
        if (typeof config === "string") errors.push(`${path}: ${config}`);
        else servers.set(name, { ...base, config, override: path });
      }
      continue;
    }
    const config = validateMcpServerConfig(name, value);
    if (typeof config === "string") {
      errors.push(`${path}: ${config}`);
      continue;
    }
    // Names that differ only in `-` and `_` would share a namespace.
    const clash = [...servers.keys()].find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name));
    if (clash) {
      errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
      continue;
    }
    if (scope === "project" && "url" in config && config.auth) {
      errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
      continue;
    }
    servers.set(name, { name, config, source: path, scope });
  }
}

/**
 * Load global and (when trusted) project MCP configuration. Disabled servers are included with
 * `enabled: false`, so they can be enabled again.
 */
export function loadMcpConfig(options: { agentDir: string; cwd: string; isProjectTrusted: boolean }): LoadedMcpConfig {
  const state: McpConfigState = { servers: new Map(), errors: [] };
  readConfigFile(join(options.agentDir, "mcp.json"), "global", state);
  const projectConfig = options.isProjectTrusted ? join(options.cwd, CONFIG_DIR_NAME, "mcp.json") : undefined;
  if (projectConfig) readConfigFile(projectConfig, "project", state);
  return {
    servers: [...state.servers.values()],
    ...(state.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: state.autoEnableCodemode }),
    ...(state.maxOutputBytes === undefined ? {} : { maxOutputBytes: state.maxOutputBytes }),
    errors: state.errors,
    ...(projectConfig ? { projectConfig } : {}),
  };
}

/** Settings `/mcp` changes. `enabled: true` and `exposure: "codemode"` are the defaults and remove the key. */
export interface McpServerConfigPatch {
  enabled?: boolean;
  exposure?: McpExposure;
}

/**
 * Change one server's settings in the `mcp.json` that defines or overrides it. With `isOverride`, a
 * missing entry is added as an override. Overrides keep default values, since they replace the global
 * server's. Other content is kept; the file is rewritten with its indentation.
 */
export function updateMcpServerConfig(
  path: string,
  name: string,
  patch: McpServerConfigPatch,
  options: { isOverride?: boolean } = {},
): void {
  editMcpServers(path, (servers, parsed) => {
    let server = servers?.[name];
    if (server === undefined && options.isOverride) {
      server = {};
      parsed.mcpServers = { ...servers, [name]: server };
    }
    if (!isRecord(server)) throw new Error(`${path} does not define MCP server "${name}"`);
    const shouldKeepDefaults = isOverrideEntry(server);
    if (patch.enabled !== undefined) {
      if (patch.enabled && !shouldKeepDefaults) delete server.enabled;
      else server.enabled = patch.enabled;
    }
    if (patch.exposure !== undefined) {
      if (patch.exposure === "codemode" && !shouldKeepDefaults) delete server.exposure;
      else server.exposure = patch.exposure;
    }
    return true;
  });
}

/**
 * Read an `mcp.json` (an empty config when missing), let `edit` change its `mcpServers`, and write
 * it back with its indentation when `edit` returns true. Other content is kept.
 */
function editMcpServers(
  path: string,
  edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): void {
  const text = existsSync(path) ? stripBom(readFileSync(path, "utf8")) : undefined;
  const parsed: unknown = text === undefined ? {} : JSON.parse(text);
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    throw new Error(`${path}: expected an object with an "mcpServers" object`);
  }
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
  if (!edit(servers, parsed)) return;
  const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed, null, indent)}\n`);
}
