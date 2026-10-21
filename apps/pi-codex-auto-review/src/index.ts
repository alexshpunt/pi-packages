import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
    type BashToolOptions,
    createBashToolDefinition,
    createEditToolDefinition,
    createFindToolDefinition,
    createGrepToolDefinition,
    createLsToolDefinition,
    createPowerShellToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
    type ExtensionAPI,
    type ExtensionFactory,
    type McpExtensionOptions,
    type ReadToolOptions,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerApprovalCommands } from "./approval-commands.js";
import { ApprovalSettingsStore } from "./approval-settings.js";
import { ApprovalManager, FileGrantPersistence } from "./approvals.js";
import { AuditLog } from "./audit.js";
import type { PermissionProfile } from "./contracts.js";
import { createProfile, GuardError } from "./contracts.js";
import { PackageApprovalStore } from "./package-approvals.js";
import { defaultProfile, type GuardSettingsInput } from "./policy/index.js";
import { ReviewApprovalCache } from "./review/cache.js";
import {
    AUTHORIZATION_ENTRY,
    REVIEW_CONTEXT_ENTRY,
    safeEvidence,
} from "./review/context.js";
import type { ReviewProvider } from "./reviewer.js";
import { GuardController, guardedToolParameters } from "./tools/controller.js";
import { PiExecutor, type ToolExecutor } from "./tools/executor.js";
import {
    createGuardedMcpExtension,
    type McpToolPolicies,
} from "./tools/mcp.js";
export interface GuardOptions {
    cwd?: string;
    agentDir?: string;
    settings?: GuardSettingsInput;
    settingsPath?: string;
    profile?: PermissionProfile;
    executor?: ToolExecutor;
    provider?: ReviewProvider;
    bashOptions?: Omit<BashToolOptions, "operations">;
    readOptions?: Omit<ReadToolOptions, "operations">;
    /** Trusted code directories are protected against model writes, including imported siblings. */
    trustedExtensionPaths?: readonly string[];
    mcp?: McpExtensionOptions | false;
    mcpToolPolicies?: McpToolPolicies;
}
export function createGuardExtension(options: GuardOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    const agentDir =
        options.agentDir ??
        process.env.PI_CODING_AGENT_DIR ??
        join(homedir(), ".pi", "agent");
    const controlDir = join(agentDir, "guard");
    const reviewCachePath = resolve(agentDir, "pi-codex-auto-review.sqlite");
    const settingsPath = options.settingsPath
        ? resolve(options.settingsPath)
        : join(controlDir, "settings.json");
    const settingsStore = new ApprovalSettingsStore(
        settingsPath,
        options.settings,
        Boolean(options.settingsPath),
    );
    type State = {
        api?: ExtensionAPI;
        controller?: GuardController;
        initialization?: Promise<GuardController>;
        registered?: boolean;
        closed?: boolean;
    };
    let current: State = {};
    async function createController(
        state: State,
        cwd: string,
    ): Promise<GuardController> {
        const settings = await settingsStore.load();
        // Only guard control files stay absolutely protected; Codex has no other default denies.
        const baseline = await defaultProfile(
            cwd,
            settings,
            [
                controlDir,
                settingsPath,
                reviewCachePath,
                `${reviewCachePath}-journal`,
                `${reviewCachePath}-wal`,
                `${reviewCachePath}-shm`,
            ],
            options.trustedExtensionPaths,
        );
        const profile = options.profile
            ? createProfile({
                  ...options.profile,
                  denyRead: [
                      ...new Set([
                          ...options.profile.denyRead,
                          ...baseline.denyRead,
                      ]),
                  ],
                  denyWrite: [
                      ...new Set([
                          ...options.profile.denyWrite,
                          ...baseline.denyWrite,
                      ]),
                  ],
                  // Callers own metadata choices, but project .pi config always needs approval.
                  readOnlyPaths: [
                      ...new Set([
                          ...(options.profile.readOnlyPaths ?? []),
                          ...(baseline.readOnlyPaths ?? []).filter(
                              (path) => basename(path) === ".pi",
                          ),
                      ]),
                  ],
              })
            : baseline;
        const audit = new AuditLog(join(controlDir, "audit.jsonl"));
        const approvals = new ApprovalManager({
            reviewTimeoutMs: settings.reviewTimeoutMs,
            approvalTimeoutMs: settings.approvalTimeoutMs,
            approvalPolicy: settings.approvalPolicy,
            approvalsReviewer: settings.approvalsReviewer,
            audit,
            persistence: new FileGrantPersistence(
                join(controlDir, "grants.json"),
            ),
            packageApprovals: new PackageApprovalStore(
                join(controlDir, "package-approvals.json"),
            ),
            reviewCache: new ReviewApprovalCache(reviewCachePath),
        });
        const controller = new GuardController({
            profile,
            settings,
            executor: options.executor ?? new PiExecutor(),
            approvals,
            audit,
            provider: options.provider,
            shellPath: options.bashOptions?.shellPath,
            persistContext: (item) =>
                state.api?.appendEntry(REVIEW_CONTEXT_ENTRY, item),
        });
        try {
            await controller.initialize(cwd);
        } catch (error) {
            await controller.close();
            throw error;
        }
        state.controller = controller;
        return controller;
    }
    function initialize(
        state: State,
        directory = cwd,
    ): Promise<GuardController> {
        if (state.closed)
            return Promise.reject(
                new GuardError(
                    "GUARD_NOT_READY",
                    "Guard is not ready for execution",
                ),
            );
        // Keep failures until reload: partial initialization must never enable a fallback.
        state.initialization ??= createController(state, directory).then(
            (guard) => {
                if (state.closed)
                    throw new GuardError(
                        "GUARD_NOT_READY",
                        "Guard is not ready for execution",
                    );
                guard.assertReady();
                return guard;
            },
        );
        return state.initialization;
    }
    function assertReady(state: State): GuardController {
        if (state.closed || !state.controller)
            throw new GuardError(
                "GUARD_NOT_READY",
                "pi-codex-auto-review is not ready for execution",
            );
        state.controller.assertReady();
        return state.controller;
    }
    async function closeState(state: State): Promise<void> {
        state.closed = true;
        await state.initialization?.catch(() => {});
        await state.controller?.close();
    }
    const factory: ExtensionFactory = async (pi) => {
        if (current.registered) {
            await closeState(current);
            current = {};
        }
        const state = current;
        state.api = pi;
        state.registered = true;
        const ready = async (directory?: string) => {
            const guard = await initialize(state, directory);
            guard.assertReady();
            return guard;
        };
        const bashOptions = (): Omit<BashToolOptions, "operations"> => {
            const settings = pi.getSettings();
            return {
                commandPrefix: settings.shellCommandPrefix,
                shellPath: settings.shellPath,
                ...options.bashOptions,
            };
        };
        const readOptions = (): Omit<ReadToolOptions, "operations"> => ({
            autoResizeImages: pi.getSettings().images?.autoResize ?? true,
            ...options.readOptions,
        });
        const register = <
            TParameters extends ToolDefinition["parameters"] & {
                properties: Record<string, ToolDefinition["parameters"]>;
            },
            TDetails,
            TState,
        >(
            definition: ToolDefinition<TParameters, TDetails, TState>,
            getOptions?: () => BashToolOptions | ReadToolOptions,
            createDelegate?: (
                cwd: string,
                options?: BashToolOptions | ReadToolOptions,
            ) => ToolDefinition<TParameters, TDetails, TState>,
        ) => {
            pi.registerTool({
                ...definition,
                parameters: guardedToolParameters(
                    definition.name,
                    definition.parameters,
                ),
                execute: async (id, params, signal, update, context) => {
                    signal?.throwIfAborted();
                    const guard = await ready(context.cwd);
                    signal?.throwIfAborted();
                    const toolOptions = getOptions?.();
                    const delegate =
                        createDelegate?.(context.cwd, toolOptions) ??
                        definition;
                    return guard
                        .wrapTool(delegate, toolOptions)
                        .execute(id, params, signal, update, context);
                },
            });
        };
        register(
            createBashToolDefinition(cwd, options.bashOptions),
            bashOptions,
            (cwd, options) =>
                createBashToolDefinition(cwd, options as BashToolOptions),
        );
        register(
            createReadToolDefinition(cwd, options.readOptions),
            readOptions,
            (cwd, options) =>
                createReadToolDefinition(cwd, options as ReadToolOptions),
        );
        register(createEditToolDefinition(cwd));
        register(createWriteToolDefinition(cwd));
        register(createGrepToolDefinition(cwd));
        register(createFindToolDefinition(cwd));
        register(createLsToolDefinition(cwd));
        // Like Pi's built-in tool, PowerShell stays inactive until defaultTools or --tools names it.
        register({
            ...createPowerShellToolDefinition(cwd),
            defaultActive: false,
        });
        pi.on("session_start", async (_event, context) => {
            const guard = await ready(context.cwd);
            guard.options.shellPath = bashOptions().shellPath;
            guard.reset(
                context.sessionManager.getSessionId(),
                context.sessionManager,
            );
            if (context.hasUI)
                context.ui.setStatus(
                    "auto-review",
                    guard.options.settings.isEnabled
                        ? undefined
                        : "Auto-review: Off",
                );
        });
        pi.on("session_tree", async (_event, context) => {
            const guard = await ready(context.cwd);
            guard.reset(
                context.sessionManager.getSessionId(),
                context.sessionManager,
            );
        });
        pi.on("session_compact", async (event, context) => {
            const guard = await ready(context.cwd);
            guard.reviewContext.summary(
                event.compactionEntry.summary,
                event.compactionEntry.id,
            );
        });
        pi.on("input", async (event, context) => {
            const guard = await ready(context.cwd);
            if (event.source === "interactive" || event.source === "rpc") {
                guard.authorizeUser(event.text);
                pi.appendEntry(AUTHORIZATION_ENTRY, {
                    text: safeEvidence(event.text, guard.reviewRedactor),
                    source: event.source,
                });
            }
        });
        pi.on("before_agent_start", async (event, context) => {
            const guard = await ready(context.cwd);
            guard.reviewContext.instructions(event);
        });
        pi.on("agent_start", async (_event, context) => {
            const guard = await ready(context.cwd);
            guard.startTurn(context);
        });
        pi.on("message_end", async (event, context) => {
            const guard = await ready(context.cwd);
            guard.reviewContext.message(event.message);
        });
        // Like Codex dynamic and extension tools, other extension tools run without approval;
        // shell, file, network and MCP actions keep their own review paths.
        pi.on("tool_call", async (event, context) => {
            const guard = await ready(context.cwd);
            guard.noteCall(event);
        });
        pi.on("tool_execution_end", async (event, context) => {
            const guard = await ready(context.cwd);
            const result = event.result ?? {},
                callIdentity = guard.reviewContext.callIdentity(
                    event.toolCallId,
                );
            guard.reviewContext.toolResult(
                {
                    tool: event.toolName,
                    toolCallId: event.toolCallId,
                    callIdentity,
                    isError: event.isError,
                    content: (result.content ?? [])
                        .filter(
                            (item: { type: string }) => item.type === "text",
                        )
                        .map((item: { text: string }) => ({
                            type: "text",
                            text: item.text,
                        })),
                    ...(result.structuredContent !== undefined
                        ? {
                              structuredContent: JSON.parse(
                                  JSON.stringify(result.structuredContent),
                              ),
                          }
                        : {}),
                    ...(event.parentToolCallId
                        ? {
                              parentToolCallId: event.parentToolCallId,
                              parentCallIdentity:
                                  guard.reviewContext.callIdentity(
                                      event.parentToolCallId,
                                  ),
                          }
                        : {}),
                },
                callIdentity,
            );
            guard.completeCall(event.toolCallId);
        });
        pi.on("user_bash", async (event, context) => {
            const guard = await ready(context.cwd);
            guard.options.shellPath = bashOptions().shellPath;
            if (!guard.options.settings.isEnabled) return;
            return {
                operations: guard.userBashOperations(context, event.command),
            };
        });
        pi.on("session_shutdown", async () => {
            await closeState(state);
        });
        registerApprovalCommands(pi, () => ready(), settingsStore);
        if (options.mcp !== false) {
            try {
                const mcp = await createGuardedMcpExtension(
                    agentDir,
                    () => assertReady(state),
                    options.mcp,
                    options.mcpToolPolicies,
                    () => ready(),
                );
                await (typeof mcp === "function" ? mcp : mcp.factory)(pi);
            } catch (error) {
                await closeState(state);
                throw error;
            }
        }
    };
    return {
        factory,
        initialize: () => initialize(current),
        assertReady: () => assertReady(current),
        async close() {
            await closeState(current);
            current = {};
        },
    };
}
export default createGuardExtension().factory;
