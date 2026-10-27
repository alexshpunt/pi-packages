import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Context, type Effect, Layer } from "effect";
import type { McpOAuthCredentialStore } from "../auth/store.ts";
import { fromPromise } from "../shared/effects.ts";
import type * as Lazy from "./lazy.ts";
import type { McpServerLog } from "./log.ts";
import type { McpTransportFactory } from "./transport.ts";

/** The loaded code and what this extension instance creates with it once. */
export interface LoadedClient {
  readonly module: typeof Lazy;
  readonly createTransport: McpTransportFactory;
  readonly credentials: McpOAuthCredentialStore;
  readonly log: McpServerLog;
}

export interface ClientLoaderShape {
  /** Loads lazy.ts on first use; later calls get the same result, including a failure. */
  readonly load: Effect.Effect<LoadedClient, unknown>;
}

/** Loads connections and OAuth on the first connection, so sessions without servers never pay for them. */
export class ClientLoader extends Context.Service<ClientLoader, ClientLoaderShape>()("pi-mcp-adapter/ClientLoader") {}

export interface ClientLoaderSettings {
  /** Defaults to stdio and streamable HTTP transports built from the server config. */
  readonly createTransport: McpTransportFactory | undefined;
  /** Defaults to `mcp-auth.json` in the agent directory. */
  readonly credentials: McpOAuthCredentialStore | undefined;
  /** File server log messages are appended to. Defaults to `mcp.log` in the agent directory. */
  readonly logPath: string | undefined;
}

export const ClientLoaderLive = (settings: ClientLoaderSettings) =>
  Layer.sync(ClientLoader, () => {
    let loading: Promise<LoadedClient> | undefined;
    return {
      load: fromPromise(() => {
        loading ??= import("./lazy.ts").then((module) => ({
          module,
          createTransport: settings.createTransport ?? module.createDefaultTransport,
          credentials: settings.credentials ?? new module.McpOAuthCredentialStore(),
          log: new module.McpServerLog(settings.logPath ?? join(getAgentDir(), "mcp.log")),
        }));
        return loading;
      }),
    } satisfies ClientLoaderShape;
  });
