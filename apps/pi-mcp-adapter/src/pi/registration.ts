/**
 * Pi's events, hooks, and registrations, handled through the services. Handlers return once the
 * services finished, so the next event sees the result.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { LoadedMcpConfig } from "../config/files.ts";
import type { McpServer } from "../servers/server.ts";
import type { ServersShape } from "../servers/service.ts";
import { errorMessage } from "../shared/effects.ts";
import { answerToolMetaRequests } from "../tools/meta.ts";
import type { ToolRegistryShape } from "../tools/registry.ts";
import { createMcpToolRenderers } from "../tools/render.ts";
import { registerMcpCommand } from "./command.ts";
import type { DiscoveryShape } from "./discovery.ts";
import { MCP_SERVERS_SECTION, renderServersSection } from "./prompt.ts";
import { describeState } from "./status.ts";

export interface McpServices {
  readonly servers: ServersShape;
  readonly registry: ToolRegistryShape;
  readonly discovery: DiscoveryShape;
}

export interface McpRegistrationOptions {
  /** Reads `mcp.json` for a starting session. */
  readonly loadConfig: (ctx: ExtensionContext) => LoadedMcpConfig;
  /** Opens the OAuth authorization URL. */
  readonly openUrl: (url: string) => void;
}

export function registerMcpExtension(pi: ExtensionAPI, services: McpServices, options: McpRegistrationOptions): void {
  const { servers, registry, discovery } = services;
  const warnWith = (ctx: ExtensionContext) => (message: string) => ctx.ui.notify(message, "warning");

  /**
   * One message for everything that needs the user after startup, or only for `only`: servers that
   * connected later and registrations rejected meanwhile.
   */
  const reportProblems = (ctx: ExtensionContext, only?: { servers: readonly McpServer[]; errors: readonly string[] }) =>
    Effect.gen(function* () {
      const errors = only ? only.errors : yield* servers.configErrors;
      const lines = errors.map((error) => `config: ${error}`);
      for (const server of only ? only.servers : yield* servers.list) {
        const state = server.connection?.state;
        if (state === "needs-auth" || state === "failed") lines.push(`${server.entry.name}: ${describeState(server)}`);
      }
      if (lines.length === 0) return;
      ctx.ui.notify(
        `MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}\nRun /mcp to fix.`,
        "warning",
      );
    });

  // Other extensions ask here for each tool's `_meta`, which pi versions without `meta` in
  // `pi.getAllTools()` do not report.
  answerToolMetaRequests(pi.events, () => Effect.runSync(registry.definitions));

  // A resumed session renders calls to MCP tools before their server connected, if it ever does.
  pi.registerToolRenderer((toolName, next) => {
    const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
    return next() ?? (match ? createMcpToolRenderers(`${match[1]}/${match[2]}`) : undefined);
  });

  registerMcpCommand(pi, { servers, discovery, openUrl: options.openUrl });

  pi.on("session_start", (_event, ctx) => {
    const config = options.loadConfig(ctx);
    Effect.runSync(
      Effect.gen(function* () {
        yield* discovery.reset;
        yield* servers.openSession({ cwd: ctx.cwd, modelRegistry: ctx.modelRegistry, config });
        // Codemode or tool_search is activated from the config: the first prompt does not wait for
        // servers whose tools are not declared to the model, and scripts or searches wait for them.
        yield* discovery.ensureActive(warnWith(ctx));
        yield* servers.connectAtStartup({
          onSettled: reportProblems(ctx),
          onLoadFailed: (error) =>
            Effect.sync(() => {
              // The session may have been disposed meanwhile, which makes ctx stale.
              try {
                ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
              } catch {}
            }),
        });
      }),
    );
  });

  // The first prompt waits for servers whose tools are declared to the model, so they are declared in
  // its first request. Every prompt lists the servers in the `mcp_servers` section as they are when it
  // starts; pi appends the section to the conversation when it changed, for example after a server
  // connected.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!(await Effect.runPromise(servers.waitForDirectServers))) {
      ctx.ui.notify("MCP servers are still connecting; their tools become available once connected.", "info");
    }
    const { sections } = event.systemPromptOptions;
    const section = renderServersSection(Effect.runSync(servers.list));
    if (section) sections[MCP_SERVERS_SECTION] = section;
    else delete sections[MCP_SERVERS_SECTION];
  });

  // Calls wait for the servers they reach, so the servers' tools are registered before they run.
  pi.on("tool_call", async (event, ctx) => {
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    if (!tool) return;
    await Effect.runPromise(
      servers.waitForCall({ toolName: event.toolName, reach: () => tool.reachesTools?.(event.input) }, ctx.signal),
    );
  });

  // Pick up sign-ins done outside the session, such as `pi mcp login` run by the agent.
  pi.on("turn_start", async (_event, ctx) => {
    if (await Effect.runPromise(servers.reconnectSignedIn)) {
      Effect.runSync(discovery.ensureActive(warnWith(ctx)));
    }
  });

  // Servers registered or unregistered during the session connect or disconnect right away.
  pi.on("mcp_servers_change", async (_event, ctx) => {
    const outcome = await Effect.runPromise(
      servers.syncRegistrations({
        onRejected: (errors) => reportProblems(ctx, { servers: [], errors }),
        onListChanged: discovery.ensureActive(warnWith(ctx)),
      }),
    );
    if (!outcome) return;
    if ("loadError" in outcome) {
      ctx.ui.notify(`MCP failed to load: ${errorMessage(outcome.loadError)}`, "error");
      return;
    }
    Effect.runSync(reportProblems(ctx, { servers: outcome.connected, errors: [] }));
  });

  pi.on("session_shutdown", async () => {
    await Effect.runPromise(servers.closeSession);
  });
}
