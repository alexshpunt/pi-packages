/**
 * `/mcp`: the manager in the TUI, a plain status otherwise, and the `login`, `logout`, and `reconnect`
 * subcommands.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { exposureOf, isEnabled, type McpServer } from "../servers/server.ts";
import type { ServersShape } from "../servers/service.ts";
import { fromPromise } from "../shared/effects.ts";
import type { DiscoveryShape } from "./discovery.ts";
import { createMcpManager, notConfiguredMessage } from "./manager.ts";
import { describeState } from "./status.ts";
import { showMcpManager } from "./ui.ts";

const MCP_USAGE = "Usage: /mcp, /mcp login [server], /mcp logout [server], /mcp reconnect [server]";

interface ServerPick {
  isEligible: (server: McpServer) => boolean;
  isPreferred: (server: McpServer) => boolean;
  none: string;
}

const usesOAuth = (server: McpServer) => server.connection?.oauthUrl !== undefined;

const OAUTH_PICK: ServerPick = {
  isEligible: usesOAuth,
  isPreferred: (server) => server.connection?.state === "needs-auth",
  none: "No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.",
};

const RECONNECT_PICK: ServerPick = {
  isEligible: (server) => server.connection !== undefined,
  isPreferred: (server) => server.connection?.state === "failed" || server.connection?.state === "disconnected",
  none: "No enabled MCP server to reconnect.",
};

export function registerMcpCommand(
  pi: ExtensionAPI,
  options: { servers: ServersShape; discovery: DiscoveryShape; openUrl: (url: string) => void },
): void {
  const { servers, discovery, openUrl } = options;
  const manager = createMcpManager(options);
  const ensureDiscoveryActive = (ctx: ExtensionCommandContext) =>
    Effect.runSync(discovery.ensureActive((warning) => ctx.ui.notify(warning, "warning")));

  const formatStatus = (): string => {
    const list = Effect.runSync(servers.list);
    const configErrors = Effect.runSync(servers.configErrors);
    const overridden = Effect.runSync(servers.overridden);
    if (list.length === 0 && configErrors.length === 0 && overridden.length === 0) return notConfiguredMessage();
    const lines = list.map((server) => {
      const { name } = server.entry;
      const exposure = exposureOf(server.entry);
      const connection = server.connection;
      if (connection?.state === "needs-auth") return `${name}: needs sign-in, run /mcp login ${name} (${exposure})`;
      const tools = connection?.state === "connected" ? `, ${connection.tools.length} tools` : "";
      const state = !isEnabled(server)
        ? "disabled"
        : connection?.state === "disconnected"
          ? "disconnected, reconnects on next call"
          : (connection?.state ?? "starting");
      const error =
        connection?.error && connection.state !== "connected"
          ? `\n    ${connection.error.split("\n").join("\n    ")}`
          : "";
      return `${name}: ${state}${tools} (${exposure})${error}`;
    });
    for (const error of configErrors) lines.push(`config error: ${error}`);
    for (const line of overridden) lines.push(`overridden: ${line}`);
    return lines.join("\n");
  };

  /** Resolve the server for a subcommand, asking when the name is omitted and ambiguous. */
  const pickServer = async (
    name: string | undefined,
    ctx: ExtensionCommandContext,
    pick: ServerPick,
  ): Promise<McpServer | undefined> => {
    if (name) {
      const server = Effect.runSync(servers.find(name));
      if (!server) ctx.ui.notify(`No MCP server named "${name}".`, "error");
      else if (!pick.isEligible(server)) ctx.ui.notify(pick.none, "error");
      return server && pick.isEligible(server) ? server : undefined;
    }
    const candidates = Effect.runSync(servers.list).filter(pick.isEligible);
    if (candidates.length === 0) {
      ctx.ui.notify(pick.none, "info");
      return undefined;
    }
    const preferred = candidates.filter(pick.isPreferred);
    if (candidates.length === 1) return candidates[0];
    if (preferred.length === 1) return preferred[0];
    const choice = await ctx.ui.select(
      "MCP server",
      candidates.map((server) => server.entry.name),
    );
    return candidates.find((server) => server.entry.name === choice);
  };

  const login = async (server: McpServer, ctx: ExtensionCommandContext) => {
    const { name } = server.entry;
    if (!ctx.hasUI) {
      ctx.ui.notify(`Signing in to MCP server "${name}" requires interactive mode.`, "error");
      return;
    }
    const lifetime = Effect.runSync(servers.lifetime);
    let failure: string | undefined;
    if (ctx.mode === "tui") {
      await showMcpManager(ctx, async (ui) => {
        failure = await manager.signIn(ui, server);
      });
    } else {
      failure = await Effect.runPromise(
        servers.signIn(server, {
          showAuthorizationUrl: (url) => {
            ctx.ui.notify(`Sign in to MCP server "${name}" in your browser:\n${url.href}`, "info");
            openUrl(url.href);
          },
          promptForRedirectUrl: (signal) =>
            fromPromise(() =>
              ctx.ui.input(
                `Waiting for sign-in to "${name}". If the browser cannot reach this machine, paste the URL it was redirected to.`,
                "http://127.0.0.1:.../callback?code=...",
                { signal },
              ),
            ),
        }),
      );
    }
    // The session ended meanwhile, which cancelled the sign-in and made ctx stale.
    if (lifetime.aborted) return;
    if (failure) {
      ctx.ui.notify(failure, failure === "Sign-in cancelled." ? "info" : "error");
      return;
    }
    ensureDiscoveryActive(ctx);
    ctx.ui.notify(`Signed in to MCP server "${name}" (${server.connection?.tools.length ?? 0} tools).`, "info");
  };

  pi.registerCommand("mcp", {
    description: "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure",
    getArgumentCompletions: (prefix) => {
      const [action, name, ...rest] = prefix.trimStart().split(/\s+/);
      if (rest.length > 0) return null;
      if (name === undefined) {
        return ["login", "logout", "reconnect"]
          .filter((item) => item.startsWith(action ?? ""))
          .map((item) => ({ value: `${item} `, label: item }));
      }
      if (action !== "login" && action !== "logout" && action !== "reconnect") return null;
      const items = Effect.runSync(servers.list)
        .filter((candidate) => (action === "reconnect" ? candidate.connection !== undefined : usesOAuth(candidate)))
        .filter((candidate) => candidate.entry.name.startsWith(name))
        .map((candidate) => ({
          value: `${action} ${candidate.entry.name}`,
          label: candidate.entry.name,
          description: describeState(candidate),
        }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (action === undefined) {
        if (ctx.mode === "tui") await showMcpManager(ctx, (ui) => manager.manage(ui, ctx));
        else {
          await Effect.runPromise(servers.awaitStartup);
          ctx.ui.notify(formatStatus(), "info");
        }
        return;
      }
      if (extra.length > 0) {
        ctx.ui.notify(MCP_USAGE, "warning");
        return;
      }
      await Effect.runPromise(servers.awaitStartup);
      switch (action) {
        case "login": {
          const server = await pickServer(name, ctx, OAUTH_PICK);
          if (server) await login(server, ctx);
          return;
        }
        case "logout": {
          const server = await pickServer(name, ctx, OAUTH_PICK);
          if (!server) return;
          const isRemoved = await Effect.runPromise(servers.signOut(server));
          ctx.ui.notify(
            isRemoved
              ? `Signed out of MCP server "${server.entry.name}".`
              : `No stored credentials for MCP server "${server.entry.name}".`,
            "info",
          );
          return;
        }
        case "reconnect": {
          const server = await pickServer(name, ctx, RECONNECT_PICK);
          if (!server) return;
          const failure = await Effect.runPromise(servers.reconnect(server));
          if (failure) ctx.ui.notify(failure, "error");
          else {
            ensureDiscoveryActive(ctx);
            ctx.ui.notify(`Reconnected to MCP server "${server.entry.name}" (${describeState(server)}).`, "info");
          }
          return;
        }
        default:
          ctx.ui.notify(MCP_USAGE, "warning");
      }
    },
  });
}
