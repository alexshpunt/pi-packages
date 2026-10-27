/**
 * The connection to one configured server: its MCP client and transport, the tools and resources it
 * offers, and its OAuth state. It connects on first use, retries transient HTTP failures, and
 * reconnects lazily when a call finds the connection gone.
 */

import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
  type CallToolResult,
  JSON_RPC_ERROR_CODES,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  McpAuthRequiredError,
  McpClient,
  McpError,
  McpHttpError,
  type McpRequestOptions,
  McpSessionExpiredError,
  type Tool as McpTool,
  type McpTransport,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  StdioTransport,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError, type OAuthChallenge } from "@earendil-works/pi-mcp/oauth";
import { Data, Effect } from "effect";
import type { McpOAuthSettings } from "../auth/oauth-client.ts";
import { createMcpAuthProvider, type McpAuthProvider } from "../auth/refresh.ts";
import type { McpOAuthCredentialStore } from "../auth/store.ts";
import type { McpServerEntry } from "../config/schema.ts";
import { resolveConfigValueOrThrow } from "../config/values.ts";
import { errorMessage, fromPromise, fromSync, makeSingleFlight, whenAborted } from "../shared/effects.ts";
import type { McpToolCaller } from "../tools/definition.ts";
import type { McpResourceServer } from "../tools/resources.ts";
import type { McpServerLog } from "./log.ts";
import type { McpTransportFactory } from "./transport.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;
/** Delays between attempts to connect to an HTTP server that failed with a transient error. */
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];

/**
 * `disconnected`: the connection dropped (for example the stdio server exited); the next call
 * reconnects.
 */
export type ServerState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";

/** A server that cannot be reached: it failed to connect, needs a sign-in, or was shut down. */
export class ConnectionError extends Data.TaggedError("ConnectionError")<{ readonly message: string }> {}

/** Network failures and overloaded or restarting servers, which are worth another attempt. */
function isTransientError(error: unknown): boolean {
  if (error instanceof McpHttpError) {
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
  }
  return error instanceof TypeError;
}

function signInRequiredMessage(entry: McpServerEntry): string {
  const provider = "url" in entry.config ? entry.config.auth?.provider : undefined;
  return `MCP server "${entry.name}" requires sign-in. Run ${provider ? `/login ${provider}` : "/mcp"} to sign in.`;
}

/** HTTP servers authenticate with OAuth unless the config supplies an `Authorization` header or `auth`. */
function usesOAuth(entry: McpServerEntry): boolean {
  const { config } = entry;
  if (!("url" in config) || config.auth) return false;
  return !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

/** Servers that do not implement `resources/templates/list` have no templates. */
async function withoutTemplates<T>(list: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await list();
  } catch (error) {
    if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return empty;
    throw error;
  }
}

export interface McpServerConnectionOptions {
  entry: McpServerEntry;
  cwd: string;
  createTransport: McpTransportFactory;
  credentials: McpOAuthCredentialStore;
  /** The current token of a pi provider, for servers with `auth.provider`. */
  providerToken: (provider: string) => Effect.Effect<string | undefined, unknown>;
  /** Called when the server offers its tools, at connect and when they change. */
  onTools: (connection: McpServerConnection) => Effect.Effect<void>;
  /** Called when `state`, `error`, or `tools` change. */
  onChange: (connection: McpServerConnection) => Effect.Effect<void>;
  /** Receives the server's log messages (`notifications/message`). */
  log: McpServerLog;
  /** Runs work the MCP client starts from its callbacks, owned by whoever owns the connection. */
  fork: (work: Effect.Effect<void>) => void;
}

export class McpServerConnection implements McpToolCaller, McpResourceServer {
  readonly entry: McpServerEntry;
  private currentState: ServerState = "connecting";
  private currentError: string | undefined;
  private offeredTools: McpTool[] = [];
  private hasResourcesCapability = false;
  private serverInstructions: string | undefined;
  private lastChallenge: OAuthChallenge | undefined;
  private client: McpClient | undefined;
  private readonly opening = makeSingleFlight<McpClient, ConnectionError>();
  /** Aborted by `close()`; cancels a connect in progress, including the wait between retries. */
  private readonly shutdown = new AbortController();
  /** Stderr of the last stdio server that failed to connect. */
  private stderrTail: string | undefined;
  private readonly authProvider: McpAuthProvider | undefined;
  private readonly options: McpServerConnectionOptions;

  constructor(options: McpServerConnectionOptions) {
    this.options = options;
    this.entry = options.entry;
    const url = this.oauthUrl;
    const provider = "url" in this.entry.config ? this.entry.config.auth?.provider : undefined;
    this.authProvider = url
      ? createMcpAuthProvider({
          serverUrl: url,
          store: options.credentials.forServer(this.entry.name, url),
          settings: () => this.oauthSettings(),
          onChallenge: (challenge) => {
            this.lastChallenge = challenge;
          },
        })
      : provider
        ? // Read on every request, so the provider's refreshes apply; MCP stores no copy.
          {
            token: () => Effect.runPromise(options.providerToken(provider)),
            settled: Effect.void,
          }
        : undefined;
  }

  get name(): string {
    return this.entry.name;
  }

  get state(): ServerState {
    return this.currentState;
  }

  get error(): string | undefined {
    return this.currentError;
  }

  get tools(): readonly McpTool[] {
    return this.offeredTools;
  }

  /**
   * Whether the server offers resources, which the resource tools list and read on demand. They are
   * not listed at connect: listing every resource can take long (a large drive, say).
   */
  get hasResources(): boolean {
    return this.hasResourcesCapability;
  }

  /** Server instructions from `initialize`, describing its tools as a group. */
  get instructions(): string | undefined {
    return this.serverInstructions;
  }

  /** Last OAuth challenge from the server; sign-in uses its resource metadata URL and scope. */
  get challenge(): OAuthChallenge | undefined {
    return this.lastChallenge;
  }

  /** Forget the challenge once a sign-in answered it. */
  clearChallenge(): void {
    this.lastChallenge = undefined;
  }

  private get isClosed(): boolean {
    return this.shutdown.signal.aborted;
  }

  get timeoutMs(): number {
    return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  /** Server URL when the server authenticates with OAuth. */
  get oauthUrl(): string | undefined {
    return usesOAuth(this.entry) && "url" in this.entry.config ? this.entry.config.url : undefined;
  }

  /** Throws when `oauth.clientSecret` cannot be resolved. */
  oauthSettings(): McpOAuthSettings {
    const oauth = "url" in this.entry.config ? this.entry.config.oauth : undefined;
    if (!oauth) return {};
    return {
      clientId: oauth.clientId,
      clientSecret:
        oauth.clientSecret === undefined
          ? undefined
          : resolveConfigValueOrThrow(oauth.clientSecret, `MCP server "${this.entry.name}" oauth.clientSecret`),
      callbackPort: oauth.callbackPort,
      callbackUrl: oauth.callbackUrl,
      scope: oauth.scope,
      clientName: oauth.clientName,
      clientRegistration: oauth.clientRegistration,
      authServerMetadataUrl: oauth.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
    };
  }

  /** The connected client. Callers that arrive while it connects wait for the same attempt. */
  getClient(): Effect.Effect<McpClient, ConnectionError> {
    return Effect.suspend(() => {
      if (this.isClosed) {
        return Effect.fail(new ConnectionError({ message: `MCP server "${this.entry.name}" is shut down` }));
      }
      const client = this.client;
      if (client?.connectionState === "connected") return Effect.succeed(client);
      return this.opening.run(this.open());
    });
  }

  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions,
  ): Effect.Effect<CallToolResult, unknown> {
    return this.withClient((client) => client.callTool(name, args, options));
  }

  readResource(uri: string, options: McpRequestOptions): Effect.Effect<ReadResourceResult, unknown> {
    return this.withClient((client) => client.readResource(uri, options), true);
  }

  resourcesPage(cursor: string | undefined, options: McpRequestOptions): Effect.Effect<ListResourcesResult, unknown> {
    return this.withClient((client) => client.listResourcesPage(cursor, options), true);
  }

  resourceTemplatesPage(
    cursor: string | undefined,
    options: McpRequestOptions,
  ): Effect.Effect<ListResourceTemplatesResult, unknown> {
    return this.withClient(
      (client) => withoutTemplates(() => client.listResourceTemplatesPage(cursor, options), { resourceTemplates: [] }),
      true,
    );
  }

  allResources(options: McpRequestOptions): Effect.Effect<Resource[], unknown> {
    return this.withClient((client) => client.listResources(options), true);
  }

  allResourceTemplates(options: McpRequestOptions): Effect.Effect<ResourceTemplate[], unknown> {
    return this.withClient((client) => withoutTemplates(() => client.listResourceTemplates(options), []), true);
  }

  /**
   * Run a request, reconnecting when needed. `isReadOnly` requests are retried once after a transient
   * HTTP error; tool calls are not, since they may have run.
   */
  private withClient<T>(
    request: (client: McpClient) => Promise<T>,
    isReadOnly = false,
    attempt = 1,
  ): Effect.Effect<T, unknown> {
    return Effect.flatMap(this.getClient(), (client) =>
      fromPromise(() => request(client)).pipe(
        Effect.catch((error) => {
          if (isReadOnly && attempt === 1 && error instanceof McpHttpError && isTransientError(error)) {
            return Effect.andThen(
              Effect.sleep(CONNECT_RETRY_DELAYS_MS[0]),
              this.withClient(request, isReadOnly, attempt + 1),
            );
          }
          if (error instanceof McpSessionExpiredError && attempt === 1) {
            // The server no longer knows the session (restart, deploy), so it did not run the request.
            // Retry once on a new session. The old client is detached but not closed: closing would
            // fail its other in-flight calls, which instead get the same 404 and retry the same way.
            return Effect.suspend(() => {
              if (this.client === client) this.client = undefined;
              return this.withClient(request, isReadOnly, attempt + 1);
            });
          }
          if (!this.needsSignIn(error)) return Effect.fail(error);
          return this.dropClient(client).pipe(
            Effect.andThen(this.markNeedsAuth()),
            Effect.andThen(Effect.fail(new ConnectionError({ message: signInRequiredMessage(this.entry) }))),
          );
        }),
      ),
    );
  }

  /** Connect again with fresh credentials, for example after signing in. */
  reconnect(): Effect.Effect<void, ConnectionError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.opening.settled;
      if (this.client) yield* this.dropClient(this.client);
      yield* this.getClient();
    });
  }

  /** Disconnect after the stored credentials were removed. */
  signOut(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      yield* this.opening.settled;
      if (this.client) yield* this.dropClient(this.client);
      if (!this.isClosed) yield* this.markNeedsAuth();
    });
  }

  /** OAuth servers that still reject the request after a refresh need the user to sign in again. */
  private needsSignIn(error: unknown): boolean {
    return (
      error instanceof McpOAuthAuthorizationRequiredError ||
      (this.authProvider !== undefined && error instanceof McpAuthRequiredError)
    );
  }

  private markNeedsAuth(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.currentState = "needs-auth";
      this.currentError = undefined;
      return this.changed();
    });
  }

  private changed(): Effect.Effect<void> {
    return this.options.onChange(this);
  }

  private dropClient(client: McpClient): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.client === client) this.client = undefined;
      return Effect.ignore(fromPromise(() => client.close()));
    });
  }

  private open(): Effect.Effect<McpClient, ConnectionError> {
    return Effect.gen({ self: this }, function* () {
      this.currentState = "connecting";
      yield* this.changed();
      const retries = "url" in this.entry.config ? CONNECT_RETRY_DELAYS_MS : [];
      for (let attempt = 0; ; attempt++) {
        this.stderrTail = undefined;
        const result = yield* Effect.result(this.connectOnce());
        if (result._tag === "Success") return result.success;
        const delayMs = retries[attempt];
        if (this.isClosed || delayMs === undefined || !isTransientError(result.failure)) {
          return yield* this.connectFailed(result.failure);
        }
        yield* Effect.raceFirst(Effect.sleep(delayMs), whenAborted(this.shutdown.signal));
        if (this.isClosed) return yield* this.connectFailed(result.failure);
      }
    });
  }

  private connectOnce(): Effect.Effect<McpClient, unknown> {
    return Effect.suspend(() => {
      const client = new McpClient({
        name: "pi",
        version: VERSION,
        requestTimeoutMs: this.timeoutMs,
        roots: [{ uri: pathToFileURL(this.options.cwd).href, name: basename(this.options.cwd) }],
      });
      const { log } = this.options;
      client.onNotification("notifications/message", (params) => log.write(this.entry.name, params));
      // Closing the client fails its pending initialize or discovery requests and closes the transport.
      // Memoized: a second `client.close()` returns before the first finished closing the transport.
      let closing: Promise<void> | undefined;
      const closeClient = () => {
        closing ??= client.close().catch(() => undefined);
        return closing;
      };
      let transport: McpTransport | undefined;
      const connect = Effect.gen({ self: this }, function* () {
        const created = yield* fromSync(() =>
          this.options.createTransport(this.entry, this.options.cwd, this.authProvider),
        );
        transport = created;
        yield* fromPromise(() => client.connect(created));
        client.onNotification("notifications/tools/list_changed", () => {
          this.options.fork(this.refreshTools(client));
        });
        const stdio = created instanceof StdioTransport ? created : undefined;
        client.onClose(() => this.options.fork(this.handleClientClose(client, stdio)));
        // Servers without the tools capability (prompts or resources only) do not answer tools/list.
        const tools = client.serverCapabilities?.tools ? yield* fromPromise(() => client.listTools()) : [];
        if (this.isClosed) return yield* Effect.fail(new Error("shut down while connecting"));
        if (client.connectionState !== "connected") {
          return yield* Effect.fail(new Error("connection closed during setup"));
        }
        this.client = client;
        this.offeredTools = tools;
        this.hasResourcesCapability = client.serverCapabilities?.resources !== undefined;
        this.serverInstructions = client.instructions?.trim() || undefined;
        this.currentState = "connected";
        this.currentError = undefined;
        yield* this.options.onTools(this);
        yield* this.changed();
        return client;
      });
      return Effect.acquireUseRelease(
        Effect.sync(() => this.shutdown.signal.addEventListener("abort", closeClient, { once: true })),
        () =>
          Effect.tapError(connect, () =>
            Effect.promise(closeClient).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (transport instanceof StdioTransport) {
                    this.stderrTail = transport.stderr.trim().slice(-STDERR_TAIL_CHARS) || undefined;
                  }
                }),
              ),
            ),
          ),
        () => Effect.sync(() => this.shutdown.signal.removeEventListener("abort", closeClient)),
      );
    });
  }

  private connectFailed(error: unknown): Effect.Effect<never, ConnectionError> {
    return Effect.suspend(() => {
      if (this.needsSignIn(error) && !this.isClosed) {
        return Effect.andThen(
          this.markNeedsAuth(),
          Effect.fail(new ConnectionError({ message: signInRequiredMessage(this.entry) })),
        );
      }
      this.currentState = this.isClosed ? "closed" : "failed";
      this.currentError = this.stderrTail ? `${errorMessage(error)}\n${this.stderrTail}` : errorMessage(error);
      const failure = new ConnectionError({
        message: `MCP server "${this.entry.name}" failed to connect: ${this.currentError}`,
      });
      return Effect.andThen(this.changed(), Effect.fail(failure));
    });
  }

  /** The transport dropped. The next call reconnects; until then the status shows why. */
  private handleClientClose(client: McpClient, stdio: StdioTransport | undefined): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.client !== client || this.isClosed) return Effect.void;
      this.client = undefined;
      this.currentState = "disconnected";
      const stderr = stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS);
      this.currentError = stderr ? `Connection closed\n${stderr}` : "Connection closed";
      return this.changed();
    });
  }

  private refreshTools(client: McpClient): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const result = yield* Effect.result(fromPromise(() => client.listTools()));
      if (result._tag === "Success") {
        if (this.client !== client || this.isClosed) return;
        this.offeredTools = result.success;
        yield* this.options.onTools(this);
      } else {
        this.currentError = `Failed to refresh tools: ${errorMessage(result.failure)}`;
      }
      yield* this.changed();
    });
  }

  /** Completes once no transport of this server is open, including one that was still connecting. */
  close(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.shutdown.abort();
      this.currentState = "closed";
      yield* this.changed();
      const client = this.client;
      this.client = undefined;
      yield* Effect.all(
        [client ? Effect.ignore(fromPromise(() => client.close())) : Effect.void, this.opening.settled],
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
      // A refresh the server already answered may have rotated the refresh token; exiting before the
      // new tokens are saved would lose the grant.
      if (this.authProvider) yield* this.authProvider.settled;
    });
  }
}
