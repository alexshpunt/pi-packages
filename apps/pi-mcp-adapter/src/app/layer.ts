import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Discovery, DiscoveryLive } from "../pi/discovery.ts";
import { PiServerRegistrations, PiToolHost } from "../pi/host.ts";
import type { McpServices } from "../pi/registration.ts";
import { ClientLoaderLive } from "../servers/loader.ts";
import { Servers, ServersLive } from "../servers/service.ts";
import { ToolRegistry, ToolRegistryLive } from "../tools/registry.ts";
import type { ResolvedMcpExtensionOptions } from "./options.ts";

/**
 * The services of one extension instance. Dependencies point downward: discovery reads the servers,
 * which register their tools in the registry and load the MCP client through the loader.
 */
function mcpLayer(pi: ExtensionAPI, options: ResolvedMcpExtensionOptions) {
  const host = PiToolHost(pi);
  return DiscoveryLive.pipe(
    Layer.provideMerge(
      ServersLive({ updateConfig: options.updateConfig, startupWaitMs: options.startupWaitMs }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ToolRegistryLive,
            ClientLoaderLive({
              createTransport: options.createTransport,
              credentials: options.credentials,
              logPath: options.logPath,
            }),
            PiServerRegistrations(pi),
          ),
        ),
      ),
    ),
    Layer.provideMerge(host),
  );
}

/**
 * Builds the services synchronously, so a failure throws before anything is registered. The runtime
 * lives as long as the extension instance and is not disposed when a session ends: the next
 * session_start reuses it. Its layers hold no operating system resources; connections close with
 * their sessions.
 */
export function buildMcpServices(pi: ExtensionAPI, options: ResolvedMcpExtensionOptions): McpServices {
  const runtime = ManagedRuntime.make(mcpLayer(pi, options));
  return runtime.runSync(Effect.all({ servers: Servers, registry: ToolRegistry, discovery: Discovery }));
}
