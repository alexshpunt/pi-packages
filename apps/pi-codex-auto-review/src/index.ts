import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
    type BashToolOptions,
    createBashToolDefinition,
    createEditToolDefinition,
    createFindToolDefinition,
    createGrepToolDefinition,
    createLsToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
    type ExtensionFactory,
    type McpExtensionOptions,
    type ReadToolOptions,
} from "@earendil-works/pi-coding-agent";
import { registerApprovalCommands } from "./approval-commands.js";
import { ApprovalSettingsStore } from "./approval-settings.js";
import { ApprovalManager, FileGrantPersistence } from "./approvals.js";
import { AuditLog } from "./audit.js";
import type { PermissionProfile } from "./contracts.js";
import { createProfile } from "./contracts.js";
import { PackageApprovalStore } from "./package-approvals.js";
import { defaultProfile, type GuardSettingsInput } from "./policy/index.js";
import { ReviewApprovalCache } from "./review/cache.js";
import {
    AUTHORIZATION_ENTRY,
    REVIEW_CONTEXT_ENTRY,
    safeEvidence,
} from "./review/context.js";
import type { ReviewProvider } from "./reviewer.js";
import { GuardController } from "./tools/controller.js";
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
    let controller: GuardController | undefined;
    const factory: ExtensionFactory = async (pi) => {
        const previous = controller;
        controller = undefined;
        await previous?.close();
        const cwd = options.cwd ?? process.cwd();
        const agentDir =
            options.agentDir ??
            process.env.PI_CODING_AGENT_DIR ??
            join(homedir(), ".pi", "agent");
        const controlDir = join(agentDir, "guard");
        const reviewCachePath = resolve(
            agentDir,
            "pi-codex-auto-review.sqlite",
        );
        const settingsPath = options.settingsPath
            ? resolve(options.settingsPath)
            : join(controlDir, "settings.json");
        const settingsStore = new ApprovalSettingsStore(
            settingsPath,
            options.settings,
            Boolean(options.settingsPath),
        );
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
        controller = new GuardController({
            profile,
            settings,
            executor: options.executor ?? new PiExecutor(),
            approvals,
            audit,
            provider: options.provider,
            shellPath: options.bashOptions?.shellPath,
            persistContext: (item) =>
                pi.appendEntry(REVIEW_CONTEXT_ENTRY, item),
        });
        try {
            await controller.initialize(cwd);
        } catch (error) {
            await controller.close();
            controller = undefined;
            throw error;
        }
        const guard = controller;
        pi.registerTool(
            guard.wrapTool(
                createBashToolDefinition(cwd, options.bashOptions),
                options.bashOptions,
            ),
        );
        pi.registerTool(
            guard.wrapTool(
                createReadToolDefinition(cwd, options.readOptions),
                options.readOptions,
            ),
        );
        pi.registerTool(guard.wrapTool(createEditToolDefinition(cwd)));
        pi.registerTool(guard.wrapTool(createWriteToolDefinition(cwd)));
        pi.registerTool(guard.wrapTool(createGrepToolDefinition(cwd)));
        pi.registerTool(guard.wrapTool(createFindToolDefinition(cwd)));
        pi.registerTool(guard.wrapTool(createLsToolDefinition(cwd)));
        pi.on("session_start", (_event, context) => {
            guard.assertReady();
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
        pi.on("session_tree", (_event, context) => {
            guard.reset(
                context.sessionManager.getSessionId(),
                context.sessionManager,
            );
        });
        pi.on("session_compact", (event) => {
            guard.reviewContext.summary(
                event.compactionEntry.summary,
                event.compactionEntry.id,
            );
        });
        pi.on("input", (event) => {
            if (event.source === "interactive" || event.source === "rpc") {
                guard.authorizeUser(event.text);
                pi.appendEntry(AUTHORIZATION_ENTRY, {
                    text: safeEvidence(event.text, guard.reviewRedactor),
                    source: event.source,
                });
            }
        });
        pi.on("before_agent_start", (event) => {
            guard.reviewContext.instructions(event);
        });
        pi.on("agent_start", (_event, context) => {
            guard.startTurn(context);
        });
        pi.on("message_end", (event) => {
            guard.reviewContext.message(event.message);
        });
        // Like Codex dynamic and extension tools, other extension tools run without approval;
        // shell, file, network and MCP actions keep their own review paths.
        pi.on("tool_call", (event) => {
            guard.assertReady();
            guard.noteCall(event);
        });
        pi.on("tool_execution_end", (event) => {
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
        pi.on("user_bash", (event, context) => {
            guard.assertReady();
            if (!guard.options.settings.isEnabled) return;
            return {
                operations: guard.userBashOperations(context, event.command),
            };
        });
        pi.on("session_shutdown", async () => {
            await guard.close();
        });
        registerApprovalCommands(pi, guard, settingsStore);
        if (options.mcp !== false) {
            try {
                const mcp = await createGuardedMcpExtension(
                    agentDir,
                    () => guard,
                    options.mcp,
                    options.mcpToolPolicies,
                );
                await (typeof mcp === "function" ? mcp : mcp.factory)(pi);
            } catch (error) {
                await guard.close();
                controller = undefined;
                throw error;
            }
        }
    };
    return {
        factory,
        assertReady() {
            if (!controller)
                throw new Error(
                    "pi-codex-auto-review extension failed to load",
                );
            controller.assertReady();
            return controller;
        },
    };
}
export default createGuardExtension().factory;
