/**
 * The `/mcp` manager in the TUI: the server list, each server's actions, its tools, and the exposure
 * menu. Menus rebuild while servers connect; actions that open or close a connection run in the
 * background so the menu stays usable.
 */

import { resolve } from "node:path";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { getMcpToolExposure, type McpExposure, type McpServerEntry } from "../config/schema.ts";
import { exposureOf, isEnabled, type McpServer } from "../servers/server.ts";
import type { ServersShape } from "../servers/service.ts";
import { fromPromise } from "../shared/effects.ts";
import type { DiscoveryShape } from "./discovery.ts";
import { describeState, firstLine } from "./status.ts";
import type { McpMenu, McpUi } from "./ui.ts";

const EXPOSURE_DESCRIPTIONS: Record<Exclude<McpExposure, "hidden">, string> = {
  codemode: "called from codemode scripts, which find them with searchTools()",
  deferred: "not declared until tool_search loads them, then called directly; no codemode needed",
  direct: "declared to the model like built-in tools",
};

/** Servers that need the user first. */
function attentionRank(server: McpServer): number {
  if (!isEnabled(server)) return 5;
  switch (server.connection?.state) {
    case "needs-auth":
      return 0;
    case "failed":
      return 1;
    case "disconnected":
      return 2;
    case "connected":
      return 4;
    default:
      return 3;
  }
}

function describeTransport(entry: McpServerEntry): string {
  const { config } = entry;
  if ("url" in config) return config.url;
  return [config.command, ...(config.args ?? [])].join(" ");
}

export function notConfiguredMessage(): string {
  return `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or .pi/mcp.json.`;
}

export interface McpManager {
  /** Browse the servers and act on them until the user closes the manager. */
  manage(ui: McpUi, ctx: ExtensionContext): Promise<void>;
  /**
   * Sign in with the manager view's sign-in screen, which shows the URL with a copy key and cancels
   * with Esc. Returns an error message on failure.
   */
  signIn(ui: McpUi, server: McpServer): Promise<string | undefined>;
}

export function createMcpManager(options: {
  servers: ServersShape;
  discovery: DiscoveryShape;
  openUrl: (url: string) => void;
}): McpManager {
  const { servers, discovery, openUrl } = options;
  /** Result of the last action on a server that failed, until the next action on it. */
  const messages = new WeakMap<McpServer, string>();
  const listeners = new Set<() => void>();
  /** Rebuilds open menus when a server changes or a message is set. */
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    const unsubscribe = Effect.runSync(servers.subscribe(listener));
    return () => {
      listeners.delete(listener);
      unsubscribe();
    };
  };
  /** Show the action's result and activate the tools that reach the server's tools. */
  const finishAction = (ctx: ExtensionContext, server: McpServer, message: string | undefined) =>
    Effect.gen(function* () {
      if (message === undefined) messages.delete(server);
      else messages.set(server, message);
      yield* discovery.ensureActive((warning) => ctx.ui.notify(warning, "warning"));
      for (const listener of listeners) listener();
    });

  const serversMenu = (): McpMenu => {
    const notices = [
      ...Effect.runSync(servers.configErrors).map((error) => `config: ${error}`),
      ...Effect.runSync(servers.overridden).map((line) => `overridden: ${line}`),
    ];
    return {
      title: "MCP servers",
      error: notices.join("\n") || undefined,
      items: [...Effect.runSync(servers.list)]
        .sort((a, b) => attentionRank(a) - attentionRank(b) || a.entry.name.localeCompare(b.entry.name))
        .map((server) => ({
          value: server.entry.name,
          label: server.entry.name,
          description: `${describeState(server)} · ${exposureOf(server.entry)} · ${server.entry.override ? "global, project override" : (server.entry.scope ?? server.entry.source)}`,
        })),
      empty: notConfiguredMessage(),
      confirmLabel: "manage",
      cancelLabel: "close",
    };
  };

  const serverMenu = (name: string): McpMenu => {
    const server = Effect.runSync(servers.find(name));
    if (!server) {
      return {
        title: name,
        items: [],
        empty: "This server is no longer configured.",
        confirmLabel: "",
        cancelLabel: "back",
      };
    }
    const { entry, connection } = server;
    const saved =
      entry.scope === "extension"
        ? "for this session"
        : entry.override
          ? "saved to the project mcp.json"
          : entry.scope
            ? `saved to the ${entry.scope} mcp.json`
            : "saved to mcp.json";
    // Global servers without an override can be turned on or off for the trusted project alone.
    const canSetInProject = entry.scope === "global" && !entry.override && Effect.runSync(servers.hasProjectConfig);
    const inProjectSaved = "saved to the project mcp.json";
    const items: SelectItem[] = [];
    if (!isEnabled(server)) {
      items.push({ value: "enable", label: "Enable", description: saved });
      if (canSetInProject) {
        items.push({ value: "enable-project", label: "Enable in this project", description: inProjectSaved });
      }
    } else {
      const state = connection?.state;
      if (state === "needs-auth") items.push({ value: "signin", label: "Sign in", description: "opens the browser" });
      if (state === "connected" && connection) {
        items.push({ value: "tools", label: "Tools", description: `${connection.tools.length} offered` });
      }
      if (state === "failed" || state === "disconnected" || state === "connected" || state === "needs-auth") {
        items.push({ value: "reconnect", label: "Reconnect" });
      }
      if (state === "connected" && connection?.oauthUrl) {
        items.push({ value: "signout", label: "Sign out", description: "deletes the stored credentials" });
      }
      items.push({ value: "exposure", label: "Exposure", description: exposureOf(entry) });
      items.push({ value: "disable", label: "Disable", description: saved });
      if (canSetInProject) {
        items.push({ value: "disable-project", label: "Disable in this project", description: inProjectSaved });
      }
    }
    const details = [
      describeTransport(entry),
      `${entry.scope ?? "config"}: ${entry.source}`,
      ...(entry.override ? [`project override: ${entry.override}`] : []),
      `State: ${describeState(server, false)}`,
    ];
    const error = [messages.get(server), connection?.state === "connected" ? undefined : connection?.error]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    return {
      title: `MCP server ${name}`,
      details: details.join("\n"),
      error: error || undefined,
      items,
      selected: items[0]?.value,
      confirmLabel: "select",
      cancelLabel: "back",
    };
  };

  const showTools = async (ui: McpUi, server: McpServer) => {
    const exposure = exposureOf(server.entry);
    const hasOverrides = Object.keys(server.entry.config.toolExposure ?? {}).length > 0;
    await ui.menu(() => ({
      title: `Tools of ${server.entry.name}`,
      details: `Exposure ${exposure}: ${exposure === "hidden" ? "unreachable" : EXPOSURE_DESCRIPTIONS[exposure]}${hasOverrides ? "\nSome tools override it with toolExposure." : ""}`,
      items: (server.connection?.tools ?? []).map((tool) => {
        const toolExposure = getMcpToolExposure(server.entry.config, tool.name);
        const description = firstLine(tool.description ?? "");
        return {
          value: tool.name,
          label: tool.name,
          description: toolExposure === exposure ? description : `[${toolExposure}] ${description}`,
        };
      }),
      empty: "The server offers no tools.",
      confirmLabel: "back",
      cancelLabel: "back",
    }));
  };

  const chooseExposure = async (ui: McpUi, server: McpServer): Promise<string | undefined> => {
    const current = exposureOf(server.entry);
    const choice = await ui.menu(() => ({
      title: `Exposure of ${server.entry.name}`,
      details:
        server.entry.scope === "extension"
          ? `Applies to this session; the server is registered by ${server.entry.source}.`
          : `Saved to ${server.entry.override ?? server.entry.source}.`,
      items: (Object.keys(EXPOSURE_DESCRIPTIONS) as (keyof typeof EXPOSURE_DESCRIPTIONS)[]).map((exposure) => ({
        value: exposure,
        label: `${exposure === current ? "✓ " : "  "}${exposure}`,
        description: EXPOSURE_DESCRIPTIONS[exposure],
      })),
      selected: current,
      confirmLabel: "save",
      cancelLabel: "back",
    }));
    if (!choice || choice === current) return undefined;
    return Effect.runPromise(servers.setExposure(server, choice as McpExposure));
  };

  const signIn = (ui: McpUi, server: McpServer): Promise<string | undefined> => {
    const title = `Sign in to ${server.entry.name}`;
    const cancel = new AbortController();
    const status = (message: string) => ui.status(title, message, () => cancel.abort());
    let authorizationUrl = "";
    status("Contacting the authorization server…");
    return Effect.runPromise(
      servers.signIn(
        server,
        {
          showAuthorizationUrl: (url) => {
            authorizationUrl = url.href;
            openUrl(url.href);
          },
          promptForRedirectUrl: (signal) =>
            Effect.map(
              fromPromise(() => ui.redirectUrl(title, authorizationUrl, signal)),
              (value) => {
                status("Connecting…");
                return value;
              },
            ),
        },
        cancel.signal,
      ),
    );
  };

  /** Keep the subscribed menu usable while a connection opens or closes. */
  const runInBackground = (
    ctx: ExtensionContext,
    server: McpServer,
    operation: Effect.Effect<string | undefined, unknown>,
  ) => {
    Effect.runSync(servers.runInBackground(server, operation, (message) => finishAction(ctx, server, message)));
  };

  const runAction = async (ui: McpUi, ctx: ExtensionContext, server: McpServer, action: string) => {
    const lifetime = Effect.runSync(servers.lifetime);
    let message: string | undefined;
    switch (action) {
      case "signin":
        message = await signIn(ui, server);
        break;
      case "reconnect":
        // Connection state and error already report failures, including required sign-ins.
        runInBackground(ctx, server, Effect.as(servers.reconnect(server), undefined));
        break;
      case "signout":
        await Effect.runPromise(servers.signOut(server));
        break;
      case "tools":
        await showTools(ui, server);
        break;
      case "exposure":
        message = await chooseExposure(ui, server);
        break;
      case "enable":
      case "disable":
      case "enable-project":
      case "disable-project": {
        const shouldEnable = action.startsWith("enable");
        runInBackground(ctx, server, servers.setEnabled(server, shouldEnable, action.endsWith("-project")));
        break;
      }
    }
    // The session ended meanwhile (for example during a sign-in), which made ctx stale.
    if (lifetime.aborted) return;
    Effect.runSync(finishAction(ctx, server, message));
  };

  return {
    manage: async (ui, ctx) => {
      for (;;) {
        const name = await ui.menu(serversMenu, subscribe);
        if (!name) return;
        for (;;) {
          const action = await ui.menu(() => serverMenu(name), subscribe);
          const server = Effect.runSync(servers.find(name));
          if (!action || !server) break;
          await runAction(ui, ctx, server, action);
        }
      }
    },
    signIn,
  };
}
