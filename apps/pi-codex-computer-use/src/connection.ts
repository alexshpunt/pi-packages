import {
    type Implementation,
    type JsonRpcMessage,
    McpClient,
    type McpTransport,
    StdioTransport,
    type Tool,
} from "@earendil-works/pi-mcp";
import type { BridgeLog } from "./log.js";
import {
    applyBrowserEnvironment,
    BROWSER_BACKENDS_VARIABLE,
    type RuntimePlan,
    SURFACES_VARIABLE,
    TRUSTED_SERVICES_VARIABLE,
} from "./runtime.js";
import type { FeatureState } from "./settings.js";

/** Codex speaks this version to the runtime (codex-mcp/src/rmcp_client.rs). */
export const PROTOCOL_VERSION = "2025-06-18";
export const PACKAGE_VERSION = "0.1.0";
export const DEFAULT_CLIENT_INFO: Implementation = {
    name: "pi-codex-computer-use",
    version: PACKAGE_VERSION,
    title: "pi Codex Computer Use",
};

/**
 * Only these host variables reach the runtime underneath the `.mcp.json` environment, so shell
 * secrets never do (02-feasibility.json recommendedEnv.baseEnvironment).
 */
const BASE_ENV_KEYS = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
    "TERM",
    // Windows
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "USERPROFILE",
    "USERNAME",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "TEMP",
    "TMP",
    "COMSPEC",
    "PATHEXT",
];

/** sky service keys as they appear in NODE_REPL_TRUSTED_SERVICES, per surface. */
const TRUSTED_SERVICE_KEYS: Record<"browser" | "computer", string> = {
    browser: "browser",
    computer: "sky",
};

export interface ComposedEnvironment {
    env: Record<string, string>;
    /** Value of CUA_REPL_ENABLED_SURFACES, in Codex's order (`browser,computer`). */
    surfaces: string;
    /** Keys kept in NODE_REPL_TRUSTED_SERVICES, or empty when the variable is omitted. */
    trustedServiceKeys: string[];
    trustedServicesSource: "filtered" | "omitted-absent" | "omitted-unparsable";
}

export function enabledSurfaces(
    state: FeatureState,
): ("browser" | "computer")[] {
    const surfaces: ("browser" | "computer")[] = [];
    if (state.browserUse) surfaces.push("browser");
    if (state.computerUse) surfaces.push("computer");
    return surfaces;
}

/**
 * `RuntimePlan.env` over an allow-listed base, with CUA_REPL_ENABLED_SURFACES derived from the flags
 * and NODE_REPL_TRUSTED_SERVICES filtered to the enabled services (omitted when absent or not a JSON
 * object, so the launcher computes it).
 */
export function composeEnvironment(
    plan: RuntimePlan,
    state: FeatureState,
    hostEnv: NodeJS.ProcessEnv = process.env,
): ComposedEnvironment {
    const env: Record<string, string> = {};
    for (const key of BASE_ENV_KEYS) {
        const value = hostEnv[key];
        if (value !== undefined) env[key] = value;
    }
    Object.assign(env, plan.env);
    const surfaces = enabledSurfaces(state);
    env[SURFACES_VARIABLE] = surfaces.join(",");
    const wantedKeys = new Set(
        surfaces.map((surface) => TRUSTED_SERVICE_KEYS[surface]),
    );
    const raw = plan.env[TRUSTED_SERVICES_VARIABLE];
    let trustedServicesSource: ComposedEnvironment["trustedServicesSource"] =
        "filtered";
    let trustedServiceKeys: string[] = [];
    if (raw === undefined) {
        trustedServicesSource = "omitted-absent";
        delete env[TRUSTED_SERVICES_VARIABLE];
    } else {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = undefined;
        }
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
        ) {
            trustedServicesSource = "omitted-unparsable";
            delete env[TRUSTED_SERVICES_VARIABLE];
        } else {
            const filtered = Object.fromEntries(
                Object.entries(parsed as Record<string, unknown>).filter(
                    ([key]) => wantedKeys.has(key),
                ),
            );
            trustedServiceKeys = Object.keys(filtered);
            env[TRUSTED_SERVICES_VARIABLE] = JSON.stringify(filtered);
        }
    }
    return {
        env: applyBrowserEnvironment(env, state.browserUse),
        surfaces: env[SURFACES_VARIABLE],
        trustedServiceKeys,
        trustedServicesSource,
    };
}

export interface ElicitationParams {
    message?: string;
    requestedSchema?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface ElicitationResult {
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
}

export type ElicitationHandler = (
    params: ElicitationParams,
    context: { signal: AbortSignal },
) => Promise<ElicitationResult> | ElicitationResult;

/** Records every message in both directions before handing it to the real transport. */
class LoggingTransport implements McpTransport {
    constructor(
        private readonly inner: McpTransport,
        private readonly log: BridgeLog,
    ) {}
    start(): Promise<void> {
        return this.inner.start();
    }
    send(message: JsonRpcMessage): Promise<void> {
        this.log.write("->", message);
        return this.inner.send(message);
    }
    close(): Promise<void> {
        return this.inner.close();
    }
    onMessage(listener: (message: JsonRpcMessage) => void): () => void {
        return this.inner.onMessage((message) => {
            this.log.write("<-", message);
            listener(message);
        });
    }
    onError(listener: (error: Error) => void): () => void {
        return this.inner.onError(listener);
    }
    onClose(listener: () => void): () => void {
        return this.inner.onClose(listener);
    }
    setProtocolVersion(version: string): void {
        this.inner.setProtocolVersion?.(version);
    }
}

export interface BridgeConnection {
    readonly plan: RuntimePlan;
    readonly state: FeatureState;
    readonly environment: ComposedEnvironment;
    readonly client: McpClient;
    readonly pid: number | undefined;
    readonly serverInfo: Implementation | undefined;
    readonly protocolVersion: string | undefined;
    readonly instructions: string | undefined;
    /** Every tool the server lists, including the ones never exposed to the model. */
    readonly tools: Tool[];
    readonly startedAt: string;
    /** Hook for the confirmations stage: replaces the placeholder that answers `cancel`. */
    setElicitationHandler(handler: ElicitationHandler): void;
    isClosed(): boolean;
    onClose(listener: () => void): () => void;
    close(): Promise<void>;
}

export interface OpenConnectionOptions {
    plan: RuntimePlan;
    state: FeatureState;
    log: BridgeLog;
    clientInfo?: Implementation;
    elicitationHandler?: ElicitationHandler;
    hostEnv?: NodeJS.ProcessEnv;
}

/**
 * Starts one `cua_repl` process from the plan, completes `initialize` (2025-06-18, elicitation.form)
 * and `tools/list`. The caller decides when to start it (never from the extension factory).
 */
export async function openConnection(
    options: OpenConnectionOptions,
): Promise<BridgeConnection> {
    const { plan, state, log } = options;
    const environment = composeEnvironment(plan, state, options.hostEnv);
    const transport = new StdioTransport({
        command: plan.command,
        args: plan.args,
        env: environment.env,
        inheritEnv: false,
        stderr: "pipe",
        onStderr: (chunk) => log.write("stderr", chunk),
        closeTimeoutMs: 5_000,
    });
    const client = new McpClient({
        ...(options.clientInfo ?? DEFAULT_CLIENT_INFO),
        capabilities: { elicitation: { form: {} } },
        protocolVersion: PROTOCOL_VERSION,
        requestTimeoutMs: plan.startupTimeoutSec * 1000,
    });
    let elicitationHandler: ElicitationHandler =
        options.elicitationHandler ??
        ((params) => {
            log.write("elicitation-unhandled", {
                message: params.message,
                meta: params._meta,
            });
            return { action: "cancel" };
        });
    client.setRequestHandler("elicitation/create", (params, context) =>
        elicitationHandler((params ?? {}) as ElicitationParams, context),
    );
    client.onError((error) => log.write("client-error", error.message));
    let closed = false;
    const closeListeners = new Set<() => void>();
    client.onClose(() => {
        closed = true;
        for (const listener of closeListeners) listener();
        closeListeners.clear();
    });
    // Field names avoid "key" so the log redaction leaves them readable.
    log.write("server-starting", {
        command: plan.command,
        args: plan.args,
        source: plan.source,
        surfaces: environment.surfaces,
        trustedServices: environment.trustedServiceKeys,
        trustedServicesSource: environment.trustedServicesSource,
        browserBackends: environment.env[BROWSER_BACKENDS_VARIABLE],
        envVariables: Object.keys(environment.env).sort(),
    });
    const initialized = await client.connect(
        new LoggingTransport(transport, log),
    );
    const tools = await client.listTools().catch(async (error: unknown) => {
        await client.close();
        throw error;
    });
    const startedAt = new Date().toISOString();
    log.write("server-connected", {
        pid: transport.pid,
        serverInfo: initialized.serverInfo,
        protocolVersion: initialized.protocolVersion,
        capabilities: initialized.capabilities,
        tools: tools.map((tool) => tool.name),
    });
    return {
        plan,
        state,
        environment,
        client,
        pid: transport.pid,
        serverInfo: initialized.serverInfo,
        protocolVersion: initialized.protocolVersion,
        instructions: initialized.instructions,
        tools,
        startedAt,
        setElicitationHandler(handler) {
            elicitationHandler = handler;
        },
        isClosed: () => closed,
        onClose(listener) {
            if (closed) listener();
            else closeListeners.add(listener);
            return () => closeListeners.delete(listener);
        },
        async close() {
            if (closed) return;
            log.write("server-closing", { pid: transport.pid });
            await client.close();
        },
    };
}
