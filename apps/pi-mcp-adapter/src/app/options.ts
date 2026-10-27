import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { openBrowser } from "../auth/browser.ts";
import type { McpOAuthCredentialStore } from "../auth/store.ts";
import {
  type LoadedMcpConfig,
  loadMcpConfig,
  type McpServerConfigPatch,
  updateMcpServerConfig,
} from "../config/files.ts";
import type { McpServerEntry } from "../config/schema.ts";
import type { McpTransportFactory } from "../servers/transport.ts";

export interface McpExtensionOptions {
  /** Defaults to reading `mcp.json` from the agent directory and the trusted project. */
  loadConfig?: (ctx: ExtensionContext) => LoadedMcpConfig;
  /** Defaults to stdio and streamable HTTP transports built from the server config. */
  createTransport?: McpTransportFactory;
  /** Defaults to `mcp-auth.json` in the agent directory. */
  credentials?: McpOAuthCredentialStore;
  /** File server log messages are appended to. Defaults to `mcp.log` in the agent directory. */
  logPath?: string;
  /** Opens the OAuth authorization URL. Defaults to the platform browser. */
  openUrl?: (url: string) => void;
  /**
   * Saves `/mcp` changes to the server's config file: its project `override` when set, else its
   * `source`. Defaults to editing that `mcp.json`.
   */
  updateConfig?: (entry: McpServerEntry, patch: McpServerConfigPatch) => void;
  /**
   * How long the first prompt waits for servers with `direct` tools that are still connecting at
   * startup, in milliseconds. Their tools become available when they connect. Other servers are
   * waited for when a script or search needs them. Default: 10000.
   */
  startupWaitMs?: number;
}

const DEFAULT_STARTUP_WAIT_MS = 10_000;

export type ResolvedMcpExtensionOptions = Required<
  Pick<McpExtensionOptions, "loadConfig" | "openUrl" | "updateConfig" | "startupWaitMs">
> &
  Pick<McpExtensionOptions, "createTransport" | "credentials" | "logPath">;

export function resolveMcpExtensionOptions(options: McpExtensionOptions): ResolvedMcpExtensionOptions {
  return {
    loadConfig:
      options.loadConfig ??
      ((ctx) => loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, isProjectTrusted: ctx.isProjectTrusted() })),
    createTransport: options.createTransport,
    credentials: options.credentials,
    logPath: options.logPath,
    openUrl: options.openUrl ?? openBrowser,
    updateConfig:
      options.updateConfig ??
      ((entry, patch) =>
        updateMcpServerConfig(entry.override ?? entry.source, entry.name, patch, {
          isOverride: entry.override !== undefined,
        })),
    startupWaitMs: options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS,
  };
}
