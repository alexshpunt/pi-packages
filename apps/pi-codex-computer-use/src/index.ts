import { dirname, join } from "node:path";
import {
    type ExtensionAPI,
    type ExtensionContext,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { ActiveCallTracker } from "./active-call.js";
import { registerCodexComputerUseCommand } from "./commands.js";
import { type BridgeConnection, openConnection } from "./connection.js";
import { createElicitationHandler } from "./elicitation.js";
import { BridgeLog } from "./log.js";
import { discoverRuntime } from "./runtime.js";
import {
    DEFAULT_FEATURE_STATE,
    FeatureSettingsStore,
    type FeatureState,
    type SettingsLoadResult,
} from "./settings.js";
import { registerBridgeTools } from "./tools.js";
import { notifyTurnEnded, TurnTracker } from "./turn.js";

export const SETTINGS_DIRECTORY_NAME = "codex-computer-use";
export const LOG_FILE_NAME = "mcp.log";
const STATUS_KEY = "codex-computer-use";

/** `<agentDir>/codex-computer-use/settings.json`, where agentDir honors `PI_CODING_AGENT_DIR`. */
export function defaultSettingsPath(): string {
    return join(getAgentDir(), SETTINGS_DIRECTORY_NAME, "settings.json");
}

function statusText(state: FeatureState, server: string): string {
    const flag = (value: boolean) => (value ? "on" : "off");
    return `codex-cua: computer ${flag(state.computerUse)} · browser ${flag(state.browserUse)} · ${server}`;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Extension entry. Loads the feature flags on `session_start`, starts one `cua_repl` server when a
 * feature is on, registers the bridged tools, forwards turn ends, and restarts on settings changes.
 * Nothing starts in this factory itself.
 */
export default function codexComputerUseExtension(pi: ExtensionAPI): void {
    const settingsPath = defaultSettingsPath();
    const store = new FeatureSettingsStore(settingsPath);
    const log = new BridgeLog(join(dirname(settingsPath), LOG_FILE_NAME));
    const turn = new TurnTracker();
    let settings: SettingsLoadResult = {
        source: "defaults",
        state: { ...DEFAULT_FEATURE_STATE },
    };
    let connection: BridgeConnection | undefined;
    let registeredToolNames: string[] = [];
    let serverProblem: string | undefined;
    let notify:
        | ((message: string, type: "info" | "warning" | "error") => void)
        | undefined;
    let sessionContext: ExtensionContext | undefined;
    const activeCalls = new ActiveCallTracker();
    const elicitationHandler = createElicitationHandler({
        activeCalls,
        getFallbackContext: () => sessionContext,
        log,
    });

    const describeServer = (): string => {
        if (connection && !connection.isClosed()) {
            const trusted = connection.environment.trustedServiceKeys.join(",");
            return `running (pid ${connection.pid ?? "?"}, surfaces ${connection.environment.surfaces || "(none)"}, trusted services ${trusted || "launcher default"}, since ${connection.startedAt})`;
        }
        if (!settings.state.computerUse && !settings.state.browserUse)
            return "not started (both features are off)";
        return serverProblem ? `not running: ${serverProblem}` : "not started";
    };
    const shortServer = (): string =>
        connection && !connection.isClosed()
            ? "running"
            : serverProblem
              ? "error"
              : "off";
    const applyStatus = (ctx: ExtensionContext) =>
        ctx.ui.setStatus(STATUS_KEY, statusText(settings.state, shortServer()));
    const bridgeDeps = {
        getConnection: () => connection,
        ensureTurn: () => turn.ensure(),
        log,
        describeServer,
        // A cancelled js call means the user interrupted the run (Codex: Interrupt).
        onCancelled: () => turn.recordOutcome("aborted"),
        activeCalls,
    };
    const refreshTools = () => {
        registeredToolNames = registerBridgeTools(
            pi,
            connection,
            bridgeDeps,
            registeredToolNames,
        );
    };

    let pendingTurnEnded: Promise<unknown> | undefined;
    const stopServer = async (reason: string): Promise<void> => {
        const current = connection;
        if (!current) return;
        connection = undefined;
        // Give an in-flight turn_ended a moment so a quitting session still notifies the runtime.
        if (pendingTurnEnded)
            await Promise.race([
                pendingTurnEnded,
                new Promise((resolve) => setTimeout(resolve, 3_000)),
            ]);
        log.write("server-stop", { reason, pid: current.pid });
        try {
            await current.close();
        } catch (error) {
            log.write("server-stop-failed", {
                reason,
                error: describeError(error),
            });
        }
    };

    const startServer = async (
        ctx: ExtensionContext,
        reason: string,
    ): Promise<void> => {
        await stopServer(`restart: ${reason}`);
        serverProblem = undefined;
        const { state } = settings;
        if (!state.computerUse && !state.browserUse) {
            log.write("server-not-started", {
                reason,
                cause: "both features off",
            });
            refreshTools();
            applyStatus(ctx);
            return;
        }
        const discovery = await discoverRuntime();
        if (discovery.kind === "unavailable") {
            serverProblem = discovery.message;
            log.write("server-not-started", {
                reason,
                cause: discovery.reason,
                message: discovery.message,
            });
            ctx.ui.notify(`Codex Computer Use: ${discovery.message}`, "error");
            refreshTools();
            applyStatus(ctx);
            return;
        }
        try {
            const opened = await openConnection({
                plan: discovery,
                state,
                log,
                elicitationHandler,
            });
            connection = opened;
            opened.onClose(() => {
                if (connection !== opened) return;
                connection = undefined;
                serverProblem = "the cua_repl server exited";
                log.write("server-closed-unexpectedly", { pid: opened.pid });
                refreshTools();
                notify?.(
                    "Codex Computer Use: the cua_repl server exited; its tools are hidden until the next restart.",
                    "warning",
                );
            });
        } catch (error) {
            serverProblem = describeError(error);
            log.write("server-start-failed", { reason, error: serverProblem });
            ctx.ui.notify(
                `Codex Computer Use could not start the cua_repl server: ${serverProblem}`,
                "error",
            );
        }
        refreshTools();
        applyStatus(ctx);
    };

    pi.on("session_start", async (event, ctx) => {
        notify = (message, type) => ctx.ui.notify(message, type);
        sessionContext = ctx;
        settings = await store.load();
        if (settings.source === "invalid") {
            const message = `Codex Computer Use: ${settings.error}. Both features are off for this session.`;
            ctx.ui.notify(message, "error");
            // No-UI modes implement notify as a no-op; keep the failure visible there too.
            if (!ctx.hasUI) process.stderr.write(`${message}\n`);
        }
        await startServer(ctx, `session_start:${event.reason}`);
    });
    pi.on("agent_start", () => {
        const started = turn.begin();
        log.write("agent-start", { turnId: started.turnId });
    });
    pi.on("agent_end", (event) => {
        // pi skips agent_before_settle for aborted runs; the last assistant message still says so.
        const last = [...event.messages]
            .reverse()
            .find((message) => message.role === "assistant");
        const stopReason =
            last && "stopReason" in last ? last.stopReason : undefined;
        const errorMessage =
            last && "errorMessage" in last ? last.errorMessage : undefined;
        log.write("agent-end", {
            turnId: turn.currentTurn?.turnId,
            stopReason,
            errorMessage,
        });
        // pi reports an abort during tool execution as an error whose message names the abort.
        if (
            stopReason === "aborted" ||
            (stopReason === "error" &&
                typeof errorMessage === "string" &&
                /aborted/i.test(errorMessage))
        )
            turn.recordOutcome("aborted");
    });
    pi.on("agent_before_settle", (event) => {
        log.write("agent-before-settle", {
            outcome: event.outcome,
            turnId: turn.currentTurn?.turnId,
        });
        turn.recordOutcome(event.outcome);
    });
    pi.on("agent_settled", (_event, ctx) => {
        const settled = turn.settle();
        log.write("agent-settled", {
            turnId: settled?.turnId,
            outcome: settled?.outcome,
            hookEventName: settled?.hookEventName,
            serverRunning: Boolean(connection && !connection.isClosed()),
        });
        if (!settled || !connection) return;
        // Not awaited: node_repl answers only after a still-running (cancelled) js call finishes.
        const notified = notifyTurnEnded(
            connection,
            ctx.sessionManager.getSessionId(),
            settled,
            log,
        ).finally(() => {
            if (pendingTurnEnded === notified) pendingTurnEnded = undefined;
        });
        pendingTurnEnded = notified;
    });
    pi.on("session_shutdown", async (event) => {
        await stopServer(`session_shutdown:${event.reason}`);
    });

    registerCodexComputerUseCommand(pi, {
        settingsPath,
        getSettings: () => settings,
        updateState: async (next, ctx) => {
            await store.save(next);
            settings = { source: "file", state: next };
            await startServer(ctx, "settings-change");
        },
        describeServer,
    });
}

export { type ActiveCall, ActiveCallTracker } from "./active-call.js";
export {
    BROWSER_FAMILY,
    type BrowserCheckOptions,
    browserPrerequisiteChecks,
    type ChromeDiagnostics,
    locateChromeDiagnostics,
} from "./browser-checks.js";
export { CHECK_COMMAND_NAME, COMMAND_NAME, COMMAND_USAGE } from "./commands.js";
export {
    type BridgeConnection,
    type ComposedEnvironment,
    composeEnvironment,
    DEFAULT_CLIENT_INFO,
    type ElicitationHandler,
    type ElicitationParams,
    type ElicitationResult,
    enabledSurfaces,
    type OpenConnectionOptions,
    openConnection,
    PROTOCOL_VERSION,
} from "./connection.js";
export {
    type ApprovalChoice,
    AUTO_APPROVE_RESPONSE,
    buildOptions,
    type Classification,
    classify,
    createElicitationHandler,
    DECLINE_REASONS,
    type DialogOption,
    type DisplayParam,
    declineWithMessage,
    type ElicitationHost,
    type ElicitationKind,
    type FormField,
    formatDialogTitle,
    isMessageOnlySchema,
    type PersistMode,
    parseFormFields,
    responseForChoice,
} from "./elicitation.js";
export {
    type CheckStatus,
    checkPrerequisites,
    formatPrerequisiteReport,
    formatSetupGuide,
    type PrerequisiteCheck,
    type PrerequisiteOptions,
    type PrerequisiteReport,
    type SetupScriptResult,
} from "./install.js";
export { BridgeLog, redactSecrets } from "./log.js";
export {
    APP_PATH_OVERRIDE_VARIABLE,
    CODEX_HOME_VARIABLE,
    describePlatform,
    detectPlatform,
    PLATFORM_OVERRIDE_VARIABLE,
    type PlatformInfo,
    type PlatformVerification,
    resolveCodexHome,
    type SupportedPlatform,
} from "./platform.js";
export {
    applyBrowserEnvironment,
    BROWSER_BACKENDS_VARIABLE,
    CODEX_DESKTOP_BUNDLE_ID,
    CUA_REPL_SERVER_NAME,
    type DiscoveryOptions,
    describeRuntime,
    discoverRuntime,
    locateServiceApp,
    pluginCacheDir,
    type RuntimeDiscovery,
    type RuntimeManifest,
    type RuntimePlan,
    type RuntimeUnavailable,
    type RuntimeUnavailableReason,
    readRuntimeManifest,
    SERVICE_APP_NAME,
    SERVICE_APP_PATH_VARIABLE,
    type ServiceAppLocation,
    SURFACES_VARIABLE,
    TRUSTED_SERVICES_VARIABLE,
} from "./runtime.js";
export {
    DEFAULT_FEATURE_STATE,
    DISABLED_FEATURE_STATE,
    describeFeatureState,
    type FeatureKey,
    FeatureSettingsStore,
    type FeatureState,
    SettingsError,
    type SettingsLoadResult,
    type SettingsSource,
    validateFeatureState,
} from "./settings.js";
export {
    type BridgeToolDetails,
    type BridgeToolResult,
    BYTES_PER_TOKEN,
    bridgeToolName,
    buildCallMeta,
    type CallMetaInput,
    convertCallToolResult,
    EXPOSED_TOOLS,
    NAMESPACE_NAME,
    registerBridgeTools,
    SERVER_NAME,
    TOOL_NAMES,
    type ToolBridgeDependencies,
    truncateMiddle,
} from "./tools.js";
export {
    type HookEventName,
    hookEventNameFor,
    notifyTurnEnded,
    type SettledTurn,
    type TurnInfo,
    TurnTracker,
} from "./turn.js";
