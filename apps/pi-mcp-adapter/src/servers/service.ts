/**
 * The servers of the current session and their connections.
 *
 * A session has the servers from `mcp.json` and the servers extensions register with
 * `pi.registerMcpServer()`; a server in `mcp.json` takes precedence over a registered server of the
 * same name. Connections run in the background, owned by this service: shutdown ends the session's
 * lifetime first, so pending work stops on it, and then waits for that work. Callers wait for the
 * servers they need, and `/mcp` changes servers through the operations here.
 */

import type { ModelRegistry, RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { Cause, Context, Data, Effect, Exit, Fiber, FiberSet, Layer, Option } from "effect";
import type { McpSignInPrompt } from "../auth/sign-in.ts";
import type { McpOAuthCredentialStore } from "../auth/store.ts";
import type { LoadedMcpConfig, McpServerConfigPatch } from "../config/files.ts";
import {
  getMcpToolExposure,
  type McpExposure,
  type McpServerEntry,
  mcpNamespace,
  validateMcpServerConfig,
} from "../config/schema.ts";
import { errorMessage, fromPromise, fromSync, whenAborted } from "../shared/effects.ts";
import type { ToolTarget } from "../tools/definition.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { MCP_RESOURCE_TOOLS } from "../tools/resources.ts";
import type { McpServerConnection } from "./connection.ts";
import { ClientLoader } from "./loader.ts";
import { exposureOf, hasDirectTools, isEnabled, type McpServer, reachesServer } from "./server.ts";

/** A call to a tool whose server is disabled or still starting, or that the server no longer offers. */
export class ToolUnavailable extends Data.TaggedError("ToolUnavailable")<{ readonly message: string }> {}

/** The servers extensions registered, as pi keeps them. */
export interface ServerRegistrationsShape {
  readonly list: Effect.Effect<readonly RegisteredMcpServer[]>;
}

export class ServerRegistrations extends Context.Service<ServerRegistrations, ServerRegistrationsShape>()(
  "pi-mcp-adapter/ServerRegistrations",
) {}

export interface SessionInput {
  readonly cwd: string;
  /** Resolves the tokens of `auth.provider`. */
  readonly modelRegistry: ModelRegistry;
  readonly config: LoadedMcpConfig;
}

export interface StartupReport {
  /** Runs once the startup connections connected or failed, unless the session ended meanwhile. */
  readonly onSettled: Effect.Effect<void>;
  /** Runs instead when the MCP client cannot be loaded. */
  readonly onLoadFailed: (error: unknown) => Effect.Effect<void>;
}

export interface RegistrationSteps {
  /** Runs first, with registrations rejected since the last change. */
  readonly onRejected: (errors: readonly string[]) => Effect.Effect<void>;
  /** Runs once the list has the new registrations, before their servers connect. */
  readonly onListChanged: Effect.Effect<void>;
}

/** The servers that connected after a registration change, or the failure to load the MCP client. */
export type RegistrationOutcome = { readonly connected: readonly McpServer[] } | { readonly loadError: unknown };

/** A tool call that may need servers to be connected before it runs. */
export interface ToolCall {
  readonly toolName: string;
  /** What the tool reaches (see `ToolDefinition.reachesTools`), read only when servers are connecting. */
  readonly reach: () => "all" | readonly string[] | undefined;
}

export interface ServersShape {
  /** Start a session with its config and the current registrations. Connects nothing yet. */
  readonly openSession: (input: SessionInput) => Effect.Effect<void>;
  /** Connect the session's enabled servers in the background; `report` hears when they are done. */
  readonly connectAtStartup: (report: StartupReport) => Effect.Effect<void>;
  /** End the session, close its connections, and wait for its background work. */
  readonly closeSession: Effect.Effect<void>;
  /**
   * Apply changed registrations: servers unregistered or registered with a new config are dropped, and
   * new ones are added and connected. Undefined when the session already ended.
   */
  readonly syncRegistrations: (steps: RegistrationSteps) => Effect.Effect<RegistrationOutcome | undefined>;
  readonly list: Effect.Effect<readonly McpServer[]>;
  readonly find: (name: string) => Effect.Effect<McpServer | undefined>;
  /** Errors in the config files and rejected registrations. */
  readonly configErrors: Effect.Effect<readonly string[]>;
  /** Registered servers that `mcp.json` overrides. */
  readonly overridden: Effect.Effect<readonly string[]>;
  /** Whether the project is trusted, so changes can be saved to its `mcp.json`. */
  readonly hasProjectConfig: Effect.Effect<boolean>;
  readonly autoEnableCodemode: Effect.Effect<boolean>;
  /** Aborted when the current session ends. */
  readonly lifetime: Effect.Effect<AbortSignal>;
  /** Call `listener` when a server, its connection, or the list changes. Returns the unsubscribe function. */
  readonly subscribe: (listener: () => void) => Effect.Effect<() => void>;
  /** Completes when the startup connections are done. */
  readonly awaitStartup: Effect.Effect<void>;
  /**
   * The first time in a session, wait up to the startup wait for servers whose tools are declared to
   * the model. False when some are still connecting.
   */
  readonly waitForDirectServers: Effect.Effect<boolean>;
  /** Wait for the servers a tool call may reach, or until `signal` aborts. */
  readonly waitForCall: (call: ToolCall, signal: AbortSignal | undefined) => Effect.Effect<void>;
  /** Returns an error message when reconnecting failed. */
  readonly reconnect: (server: McpServer) => Effect.Effect<string | undefined>;
  /**
   * Returns an error message when the config could not be saved; connection errors show in the state.
   * `isProjectOverride` saves the change as an override in the project `mcp.json`. Fails when the MCP
   * client cannot be loaded.
   */
  readonly setEnabled: (
    server: McpServer,
    shouldEnable: boolean,
    isProjectOverride?: boolean,
  ) => Effect.Effect<string | undefined, unknown>;
  /** Returns an error message when the config could not be saved. */
  readonly setExposure: (server: McpServer, exposure: McpExposure) => Effect.Effect<string | undefined>;
  /** Sign in, then reconnect. Returns an error message on failure. `cancel` or the session's end stops it. */
  readonly signIn: (
    server: McpServer,
    prompt: McpSignInPrompt,
    cancel?: AbortSignal,
  ) => Effect.Effect<string | undefined, unknown>;
  /** Remove the stored credentials and disconnect. Returns whether credentials were stored. */
  readonly signOut: (server: McpServer) => Effect.Effect<boolean, unknown>;
  /**
   * Reconnect servers that need a sign-in when their credentials were stored since, for example by
   * `pi mcp login` in another process. Returns whether any server reconnected.
   */
  readonly reconnectSignedIn: Effect.Effect<boolean>;
  /**
   * Run `operation` on `server` in the background, so a menu stays usable while it opens or closes a
   * connection. `onDone` gets its result unless the session ended, the server was removed, or another
   * attempt to connect it started meanwhile.
   */
  readonly runInBackground: (
    server: McpServer,
    operation: Effect.Effect<string | undefined, unknown>,
    onDone: (message: string | undefined) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
}

export class Servers extends Context.Service<Servers, ServersShape>()("pi-mcp-adapter/Servers") {}

export interface ServersSettings {
  /**
   * Saves `/mcp` changes to the server's config file: its project `override` when set, else its
   * `source`.
   */
  readonly updateConfig: (entry: McpServerEntry, patch: McpServerConfigPatch) => void;
  /**
   * How long the first prompt waits for servers with `direct` tools that are still connecting at
   * startup, in milliseconds.
   */
  readonly startupWaitMs: number;
}

/** A server with what this service tracks of its connection. */
interface ServerRecord {
  entry: McpServerEntry;
  connection?: McpServerConnection;
  /** For servers extensions registered: the config as registered, to detect re-registrations. */
  registeredConfig?: string;
  /** Identifies the current connection attempt; disabling or replacing it invalidates earlier work. */
  attempt?: symbol;
  /** Completes when the connection started for the server connected or failed. */
  ready?: Fiber.Fiber<void, unknown>;
  /** Closing of a detached connection; a replacement waits for it before opening a transport. */
  closing?: Fiber.Fiber<void>;
}

/** Every `McpServer` other features have is a record this service created. */
function recordOf(server: McpServer): ServerRecord {
  return server as ServerRecord;
}

interface Session {
  /** Aborted when the session ends. Work captures it when it starts and drops late results once it aborted. */
  readonly lifetime: AbortController;
  /** Working directory of the session, for stdio servers. */
  readonly cwd: string;
  readonly modelRegistry: ModelRegistry | undefined;
  /** Servers from `mcp.json`, which take precedence over registered servers of the same name. */
  readonly configuredEntries: readonly McpServerEntry[];
  readonly configErrors: readonly string[];
  /** The trusted project's `mcp.json`, where `/mcp` saves project overrides of global servers. */
  readonly projectConfig: string | undefined;
  readonly autoEnableCodemode: boolean;
  /** The top-level `maxOutputBytes` of `mcp.json`, for servers without their own. */
  readonly maxOutputBytes: number | undefined;
  /** Registered servers whose config is invalid, reported with the config errors. */
  registrationErrors: readonly string[];
  overridden: readonly string[];
  servers: ServerRecord[];
  /** Whether a prompt already waited for the startup connections. */
  hasWaitedForStartup: boolean;
  /** Connecting the enabled servers at startup. */
  startup?: Fiber.Fiber<void>;
}

/** Before the first session starts; registrations made meanwhile are read when it does. */
function endedSession(): Session {
  const lifetime = new AbortController();
  lifetime.abort();
  return {
    lifetime,
    cwd: process.cwd(),
    modelRegistry: undefined,
    configuredEntries: [],
    configErrors: [],
    projectConfig: undefined,
    autoEnableCodemode: true,
    maxOutputBytes: undefined,
    registrationErrors: [],
    overridden: [],
    servers: [],
    hasWaitedForStartup: false,
  };
}

/** The next macrotask, so the first render happens before the MCP client loads. */
const afterRender = Effect.callback<void>((resume) => {
  const handle = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(handle));
});

export const ServersLive = (settings: ServersSettings) =>
  Layer.effect(
    Servers,
    Effect.gen(function* () {
      const registry = yield* ToolRegistry;
      const loader = yield* ClientLoader;
      const registrations = yield* ServerRegistrations;
      /** Connections, `/mcp` actions, and sign-ins, which shutdown waits for. */
      const fibers = yield* FiberSet.make<unknown, unknown>();
      const runFork = yield* FiberSet.runtime(fibers)<never>();
      let session = endedSession();
      const listeners = new Set<() => void>();
      const emitChange = () => {
        for (const listener of listeners) listener();
      };
      /**
       * Stored tokens of servers waiting for a sign-in, as they were when the sign-in was needed, with
       * the store they are read from. `pi mcp login` in another process (for example run by the agent)
       * changes them.
       */
      const tokensAtSignIn = new Map<McpServerConnection, { tokens: string; credentials: McpOAuthCredentialStore }>();

      const findServer = (name: string) => session.servers.find((server) => server.entry.name === name);
      /**
       * Configured `maxOutputBytes` of a server's results: its own, else the top-level one. Results about
       * every server (`name` undefined) use the top-level one.
       */
      const serverMaxOutputBytes = (name: string | undefined) =>
        (name === undefined ? undefined : findServer(name)?.entry.config.maxOutputBytes) ?? session.maxOutputBytes;
      /** Enabled servers with resources whose exposure is not `hidden`, which the resource tools reach. */
      const serversWithResources = () =>
        session.servers.filter(
          (server) => server.connection?.hasResources && isEnabled(server) && exposureOf(server.entry) !== "hidden",
        );
      const resourceServers = () =>
        serversWithResources().flatMap((server) => (server.connection ? [server.connection] : []));

      const syncResourceTools = Effect.suspend(() =>
        registry.syncResourceTools({
          exposures: new Set(serversWithResources().map((server) => exposureOf(server.entry))),
          servers: resourceServers,
          maxOutputBytes: serverMaxOutputBytes,
        }),
      );

      const toolTarget = (name: string): ToolTarget => ({
        // A prepared call can outlive the connection that registered the tool while the readiness hook
        // waits for a disable and re-enable, so the connection is resolved when the call runs.
        caller: (tool) =>
          Effect.suspend(() => {
            const current = findServer(name);
            if (!current || !isEnabled(current)) {
              return Effect.fail(new ToolUnavailable({ message: `MCP server "${name}" is disabled.` }));
            }
            const connection = current.connection;
            if (!connection) {
              return Effect.fail(new ToolUnavailable({ message: `MCP server "${name}" is still starting.` }));
            }
            if (
              getMcpToolExposure(current.entry.config, tool) === "hidden" ||
              (connection.state === "connected" && !connection.tools.some((offered) => offered.name === tool))
            ) {
              return Effect.fail(
                new ToolUnavailable({ message: `MCP tool "${name}/${tool}" is no longer available.` }),
              );
            }
            return Effect.succeed(connection);
          }),
        hasReadableResources: () => resourceServers().some((connection) => connection.name === name),
        maxOutputBytes: () => serverMaxOutputBytes(name),
      });

      const registerTools = (connection: McpServerConnection) =>
        Effect.suspend(() => {
          const name = connection.entry.name;
          const entry = findServer(name)?.entry ?? connection.entry;
          return Effect.andThen(
            registry.registerServerTools({
              server: name,
              config: entry.config,
              tools: connection.tools,
              instructions: connection.instructions,
              timeoutMs: connection.timeoutMs,
              target: toolTarget(name),
            }),
            syncResourceTools,
          );
        });

      const hideTools = (name: string) => Effect.andThen(registry.hideServerTools(name), syncResourceTools);

      const storedTokens = (connection: McpServerConnection, credentials: McpOAuthCredentialStore): string => {
        const url = connection.oauthUrl;
        return url ? JSON.stringify(credentials.tokens(connection.name, url) ?? null) : "null";
      };

      /**
       * Servers extensions registered, except names `mcp.json` defines, which take precedence. Pi validates
       * registrations without the settings it does not know, such as `maxOutputBytes`, so they are validated
       * again; invalid ones are left out and returned as `errors`.
       */
      const registeredServers = Effect.map(registrations.list, (registered) => {
        const servers: ServerRecord[] = [];
        const overridden: string[] = [];
        const errors: string[] = [];
        for (const { name, config: registeredConfig, extensionPath } of registered) {
          const configured = session.configuredEntries.find((entry) => mcpNamespace(entry.name) === mcpNamespace(name));
          if (configured) {
            overridden.push(
              `"${name}" registered by ${extensionPath} is overridden by "${configured.name}" in ${configured.source}`,
            );
            continue;
          }
          const config = validateMcpServerConfig(name, registeredConfig);
          if (typeof config === "string") {
            errors.push(`${extensionPath}: ${config}`);
            continue;
          }
          servers.push({
            entry: { name, config, source: extensionPath, scope: "extension" },
            registeredConfig: JSON.stringify(registeredConfig),
          });
        }
        return { servers, overridden, errors };
      });

      /** Create the server's connection, loading the MCP client on first use. */
      const createConnection = (server: ServerRecord, isCurrent: () => boolean) =>
        Effect.gen(function* () {
          const client = yield* loader.load;
          if (!isCurrent()) return undefined;
          const connection = new client.module.McpServerConnection({
            entry: server.entry,
            cwd: session.cwd,
            createTransport: client.createTransport,
            credentials: client.credentials,
            providerToken: (provider) => fromPromise(async () => session.modelRegistry?.getApiKeyForProvider(provider)),
            log: client.log,
            fork: (work) => {
              runFork(work);
            },
            onTools: (connection) => (isCurrent() ? registerTools(connection) : Effect.void),
            onChange: (connection) =>
              Effect.sync(() => {
                if (!isCurrent()) {
                  tokensAtSignIn.delete(connection);
                  return;
                }
                if (connection.state !== "needs-auth") tokensAtSignIn.delete(connection);
                else if (!tokensAtSignIn.has(connection)) {
                  const { credentials } = client;
                  tokensAtSignIn.set(connection, { tokens: storedTokens(connection, credentials), credentials });
                }
                emitChange();
              }),
          });
          server.connection = connection;
          emitChange();
          return connection;
        });

      /**
       * Connect the server in the background. `server.ready` completes when it connected or failed;
       * failures show in its state. It starts after `after`, unless disabled, replaced, or shut down
       * meanwhile. The returned fiber fails when the MCP client cannot be loaded.
       */
      const startConnection = (server: ServerRecord, after: Effect.Effect<unknown, unknown> = Effect.void) =>
        Effect.suspend(() => {
          const { signal } = session.lifetime;
          const attempt = Symbol();
          server.attempt = attempt;
          const isCurrent = () =>
            !signal.aborted && server.attempt === attempt && isEnabled(server) && session.servers.includes(server);
          const connect = Effect.gen(function* () {
            yield* after;
            if (!isCurrent()) return;
            const connection = yield* createConnection(server, isCurrent);
            if (!connection || !isCurrent()) return;
            yield* Effect.ignore(connection.getClient());
          });
          return Effect.tap(FiberSet.run(fibers, connect), (fiber) =>
            Effect.sync(() => {
              server.ready = fiber;
            }),
          );
        });

      const closeConnections = (servers: readonly ServerRecord[]) =>
        Effect.forEach(servers, (server) => (server.connection ? server.connection.close() : Effect.void), {
          concurrency: "unbounded",
          discard: true,
        });

      /** Wait for the latest connection attempts, including ones started while waiting, or an abort. */
      const waitForServers = (waiting: readonly ServerRecord[], signal: AbortSignal | undefined) =>
        Effect.gen(function* () {
          for (;;) {
            const attempts = waiting.flatMap((server) =>
              isEnabled(server) && session.servers.includes(server) && server.ready
                ? [{ server, ready: server.ready }]
                : [],
            );
            if (attempts.length === 0 || signal?.aborted) return;
            yield* Effect.raceFirst(
              Effect.forEach(attempts, (attempt) => Fiber.await(attempt.ready), { discard: true }),
              whenAborted(signal),
            );
            const isSettled = attempts.every(
              (attempt) =>
                !isEnabled(attempt.server) ||
                !session.servers.includes(attempt.server) ||
                attempt.ready === attempt.server.ready,
            );
            if (signal?.aborted || isSettled) return;
          }
        });

      /**
       * Save a config change; returns an error message when the file could not be updated. Changes to
       * registered servers only apply to the current session.
       */
      const saveConfig = (server: ServerRecord, patch: McpServerConfigPatch, isProjectOverride = false) =>
        Effect.suspend(() => {
          const override = isProjectOverride ? session.projectConfig : server.entry.override;
          const entry = override ? { ...server.entry, override } : server.entry;
          const save = entry.scope === "extension" ? Effect.void : fromSync(() => settings.updateConfig(entry, patch));
          return save.pipe(
            Effect.map((): string | undefined => {
              server.entry = { ...entry, config: { ...entry.config, ...patch } };
              return undefined;
            }),
            Effect.catch((error) =>
              Effect.succeed(`Could not update ${entry.override ?? entry.source}: ${errorMessage(error)}`),
            ),
          );
        });

      return {
        openSession: ({ cwd, modelRegistry, config }) =>
          Effect.gen(function* () {
            const next: Session = {
              lifetime: new AbortController(),
              cwd,
              modelRegistry,
              configuredEntries: config.servers,
              configErrors: config.errors,
              projectConfig: config.projectConfig,
              autoEnableCodemode: config.autoEnableCodemode ?? true,
              maxOutputBytes: config.maxOutputBytes,
              registrationErrors: [],
              overridden: [],
              servers: [],
              hasWaitedForStartup: false,
            };
            session = next;
            const registered = yield* registeredServers;
            next.overridden = registered.overridden;
            next.registrationErrors = registered.errors;
            next.servers = [...config.servers.map((entry) => ({ entry })), ...registered.servers];
            emitChange();
          }),

        connectAtStartup: (report) =>
          Effect.gen(function* () {
            const current = session;
            const { signal } = current.lifetime;
            const enabled = current.servers.filter(isEnabled);
            if (enabled.length === 0) return yield* report.onSettled;
            // The MCP client loads only now, so sessions without servers never pay for it.
            const loading = yield* FiberSet.run(fibers, Effect.andThen(afterRender, loader.load));
            const attempts = yield* Effect.forEach(enabled, (server) => startConnection(server, Fiber.join(loading)));
            current.startup = yield* FiberSet.run(
              fibers,
              Effect.forEach(attempts, Fiber.join, { discard: true }).pipe(
                Effect.matchEffect({
                  onSuccess: () => (signal.aborted ? Effect.void : report.onSettled),
                  onFailure: report.onLoadFailed,
                }),
              ),
            );
          }),

        closeSession: Effect.gen(function* () {
          session.lifetime.abort();
          const closing = session.servers;
          session.servers = [];
          emitChange();
          yield* closeConnections(closing);
          yield* FiberSet.awaitEmpty(fibers);
        }),

        syncRegistrations: (steps) =>
          Effect.gen(function* () {
            const current = session;
            const { signal } = current.lifetime;
            if (signal.aborted) return undefined;
            const registered = yield* registeredServers;
            current.overridden = registered.overridden;
            const rejected = registered.errors.filter((error) => !current.registrationErrors.includes(error));
            current.registrationErrors = registered.errors;
            if (rejected.length > 0) yield* steps.onRejected(rejected);
            const next = new Map(registered.servers.map((server) => [server.entry.name, server]));
            // Unregistered servers and re-registered ones with a new config are dropped; the latter come back below.
            const removed = current.servers.filter(
              (server) =>
                server.entry.scope === "extension" &&
                next.get(server.entry.name)?.registeredConfig !== server.registeredConfig,
            );
            current.servers = current.servers.filter((server) => !removed.includes(server));
            for (const server of removed) yield* hideTools(server.entry.name);
            const added = registered.servers.filter((server) => !findServer(server.entry.name));
            current.servers.push(...added);
            emitChange();
            yield* steps.onListChanged;
            yield* closeConnections(removed);
            const connecting = added.filter(isEnabled);
            if (signal.aborted || connecting.length === 0) return { connected: [] };
            const attempts = yield* Effect.forEach(connecting, (server) => startConnection(server));
            const joined = yield* Effect.result(Effect.forEach(attempts, Fiber.join, { discard: true }));
            if (joined._tag === "Failure") return { loadError: joined.failure };
            if (signal.aborted) {
              yield* closeConnections(connecting);
              return undefined;
            }
            return { connected: connecting };
          }),

        list: Effect.sync(() => [...session.servers]),
        find: (name) => Effect.sync(() => findServer(name)),
        configErrors: Effect.sync(() => [...session.configErrors, ...session.registrationErrors]),
        overridden: Effect.sync(() => session.overridden),
        hasProjectConfig: Effect.sync(() => session.projectConfig !== undefined),
        autoEnableCodemode: Effect.sync(() => session.autoEnableCodemode),
        lifetime: Effect.sync(() => session.lifetime.signal),

        subscribe: (listener) =>
          Effect.sync(() => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          }),

        awaitStartup: Effect.suspend(() =>
          session.startup ? Effect.ignore(Fiber.join(session.startup)) : Effect.void,
        ),

        // A slow or hanging server must not hold up the prompt; other servers are waited for when a
        // script or search needs them.
        waitForDirectServers: Effect.suspend(() => {
          if (session.hasWaitedForStartup) return Effect.succeed(true);
          session.hasWaitedForStartup = true;
          const attempts = session.servers.flatMap((server) =>
            isEnabled(server) && hasDirectTools(server.entry) && server.ready ? [server.ready] : [],
          );
          if (attempts.length === 0) return Effect.succeed(true);
          return Effect.forEach(attempts, Fiber.await, { discard: true }).pipe(
            Effect.timeoutOption(settings.startupWaitMs),
            Effect.map(Option.isSome),
          );
        }),

        // A tool that reaches other tools (`reachesTools`) waits for the servers it may reach, so their
        // tools are registered before it runs: a codemode script for the servers it names, or for every
        // server when it searches or enumerates tools, and tool_search for every server. The resource
        // tools reach every server, so they wait for all of them. Direct MCP calls wait only for their
        // own server, including a reconnect still closing its old transport.
        waitForCall: (call, signal) =>
          Effect.gen(function* () {
            // Readiness can be pending while the display state is still connected: reconnect first
            // closes the old transport, then opens a new one. Finished attempts return immediately.
            const readyServers = session.servers.filter((server) => isEnabled(server) && server.ready);
            if (readyServers.length === 0) return;
            const reach = call.reach();
            let waiting: ServerRecord[];
            if (reach !== undefined) {
              waiting = readyServers.filter((server) => reachesServer(reach, server.entry.name));
            } else if (MCP_RESOURCE_TOOLS.has(call.toolName)) {
              waiting = readyServers;
            } else {
              const owner = yield* registry.serverOf(call.toolName);
              waiting = readyServers.filter((server) => server.entry.name === owner);
            }
            yield* waitForServers(waiting, signal);
          }),

        reconnect: (server) =>
          Effect.gen(function* () {
            const record = recordOf(server);
            const connection = record.connection;
            if (!connection) return `MCP server "${record.entry.name}" is disabled.`;
            const previous = record.ready;
            const reconnecting = yield* FiberSet.run(
              fibers,
              Effect.andThen(previous ? Fiber.await(previous) : Effect.void, connection.reconnect()),
            );
            record.ready = reconnecting;
            const exit = yield* Fiber.await(reconnecting);
            return Exit.isSuccess(exit) ? undefined : errorMessage(Cause.squash(exit.cause));
          }),

        setEnabled: (server, shouldEnable, isProjectOverride = false) =>
          Effect.gen(function* () {
            const record = recordOf(server);
            const failed = yield* saveConfig(record, { enabled: shouldEnable }, isProjectOverride);
            if (failed) return failed;
            if (shouldEnable) {
              const closing = record.closing;
              yield* Fiber.join(yield* startConnection(record, closing ? Fiber.await(closing) : Effect.void));
              return undefined;
            }
            const connection = record.connection;
            const previous = record.ready;
            record.attempt = undefined;
            record.connection = undefined;
            if (connection) {
              // A reconnect may already have detached its old client while awaiting transport
              // shutdown. Closing the connection alone does not wait for that reconnect.
              record.closing = yield* FiberSet.run(
                fibers,
                Effect.andThen(connection.close(), previous ? Effect.asVoid(Fiber.await(previous)) : Effect.void),
              );
            }
            const closing = record.closing;
            yield* hideTools(record.entry.name);
            emitChange();
            if (closing) {
              yield* Effect.ensuring(
                Fiber.await(closing),
                Effect.sync(() => {
                  if (record.closing === closing) record.closing = undefined;
                }),
              );
            }
            return undefined;
          }),

        setExposure: (server, exposure) =>
          Effect.gen(function* () {
            const record = recordOf(server);
            const failed = yield* saveConfig(record, { exposure });
            if (failed) return failed;
            if (record.connection?.state === "connected") yield* registerTools(record.connection);
            yield* syncResourceTools;
            // Tools no longer exposed directly leave the declared set; direct tools are activated on registration.
            yield* registry.deactivateIndirectTools(record.entry.name);
            emitChange();
            return undefined;
          }),

        signIn: (server, prompt, cancel) =>
          Effect.gen(function* () {
            const record = recordOf(server);
            const connection = record.connection;
            const url = connection?.oauthUrl;
            if (!connection || !url) return `MCP server "${record.entry.name}" does not use OAuth.`;
            const client = yield* loader.load;
            const lifetime = session.lifetime.signal;
            const signal = cancel ? AbortSignal.any([lifetime, cancel]) : lifetime;
            const signingIn = Effect.flatMap(
              fromSync(() => connection.oauthSettings()),
              (oauthSettings) =>
                client.module.signInMcpServer({
                  serverUrl: url,
                  store: client.credentials.forServer(record.entry.name, url),
                  settings: oauthSettings,
                  challenge: connection.challenge,
                  prompt,
                  signal,
                }),
            );
            // Shutdown waits for the sign-in to stop.
            const exit = yield* Fiber.await(yield* FiberSet.run(fibers, signingIn));
            if (Exit.isFailure(exit)) {
              const error = Cause.squash(exit.cause);
              if (error instanceof client.module.SignInCancelled) return "Sign-in cancelled.";
              return `Sign-in failed: ${errorMessage(error)}`;
            }
            // The challenge that asked for this sign-in (for example for more scope) is answered.
            connection.clearChallenge();
            const reconnected = yield* Effect.result(connection.reconnect());
            return reconnected._tag === "Success" ? undefined : `Signed in, but ${reconnected.failure.message}`;
          }),

        signOut: (server) =>
          Effect.gen(function* () {
            const record = recordOf(server);
            const connection = record.connection;
            const url = connection?.oauthUrl;
            if (!connection || !url) return false;
            const { credentials } = yield* loader.load;
            const isRemoved = yield* fromSync(() => credentials.remove(record.entry.name, url));
            yield* connection.signOut();
            return isRemoved;
          }),

        reconnectSignedIn: Effect.gen(function* () {
          const signedIn = [...tokensAtSignIn].filter(
            ([connection, { tokens, credentials }]) => storedTokens(connection, credentials) !== tokens,
          );
          if (signedIn.length === 0) return false;
          for (const [connection] of signedIn) tokensAtSignIn.delete(connection);
          yield* Effect.forEach(signedIn, ([connection]) => Effect.ignore(connection.reconnect()), {
            concurrency: "unbounded",
            discard: true,
          });
          return true;
        }),

        runInBackground: (server, operation, onDone) =>
          Effect.gen(function* () {
            const record = recordOf(server);
            const { signal } = session.lifetime;
            const running = yield* FiberSet.run(fibers, operation);
            // Read once the operation started, since enabling or disabling starts a new attempt.
            const attempt = record.attempt;
            yield* FiberSet.run(
              fibers,
              Effect.gen(function* () {
                const exit = yield* Fiber.await(running);
                const message = Exit.isSuccess(exit) ? exit.value : errorMessage(Cause.squash(exit.cause));
                if (signal.aborted || record.attempt !== attempt || !session.servers.includes(record)) return;
                yield* onDone(message);
              }),
            );
          }),
      } satisfies ServersShape;
    }),
  );
