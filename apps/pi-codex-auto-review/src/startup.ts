import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
    type CreateAgentSessionOptions,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createCodemodeExtension,
    type InlineExtension,
    type ModelRuntime,
    ProjectTrustStore,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadContextFiles } from "./context-files.js";
import { GuardError } from "./contracts.js";
import { createGuardExtension, type GuardOptions } from "./index.js";
import { getPiSDKEntryPath } from "./pi-host.js";
import {
    type ExternalExtension,
    guardedExternalExtension,
} from "./tools/mcp.js";

const MINIMUM_PI_MAJOR_VERSION = 1;

export async function assertSupportedPi(): Promise<string> {
    let path = dirname(getPiSDKEntryPath());
    for (let i = 0; i < 8; i++) {
        try {
            const pkg = JSON.parse(
                await readFile(join(path, "package.json"), "utf8"),
            );
            if (pkg.name === "@earendil-works/pi-coding-agent") {
                const majorVersion = Number(
                    /^(\d+)\./.exec(String(pkg.version))?.[1],
                );
                if (!(majorVersion >= MINIMUM_PI_MAJOR_VERSION))
                    throw new GuardError(
                        "UNSUPPORTED_PI",
                        "Pi APIs are not qualified for this version",
                    );
                return pkg.version as string;
            }
        } catch (error) {
            if (error instanceof GuardError) throw error;
        }
        path = dirname(path);
    }
    throw new GuardError(
        "UNSUPPORTED_PI",
        "Host Pi version could not be verified",
    );
}
export interface GuardedRuntimeOptions extends GuardOptions {
    cwd: string;
    agentDir: string;
    modelRuntime?: ModelRuntime;
    settingsManager?: SettingsManager;
    /** Explicit trust for the initially selected project; later cwd changes use their own trust record. */
    isProjectTrusted?: boolean;
    model?: CreateAgentSessionOptions["model"];
    /** Resolve an explicitly selected model after trusted provider extensions have registered. */
    modelSelection?: { readonly provider: string; readonly id: string };
    sessionManager?: SessionManager;
    trustedExtensions?: InlineExtension[];
    externalExtensions?: readonly ExternalExtension[];
}
export async function createGuardedRuntime(options: GuardedRuntimeOptions) {
    await assertSupportedPi();
    if (options.model && options.modelSelection)
        throw new GuardError(
            "CONFLICTING_MODEL_SELECTION",
            "Provide either a model object or a provider/model selection",
        );
    if (
        options.isProjectTrusted !== undefined &&
        typeof options.isProjectTrusted !== "boolean"
    )
        throw new GuardError(
            "INVALID_PROJECT_TRUST",
            "Project trust must be an explicit boolean",
        );
    const initialCwd = resolve(options.cwd),
        agentDir = resolve(options.agentDir);
    const trustedExtensionPaths = (options.trustedExtensionPaths ?? []).map(
        (path) => resolve(initialCwd, path),
    );
    const createRuntime = async (input: {
        cwd: string;
        agentDir: string;
        sessionManager: SessionManager;
        sessionStartEvent?: CreateAgentSessionOptions["sessionStartEvent"];
    }) => {
        const settingsManager =
            options.settingsManager ??
            SettingsManager.create(input.cwd, input.agentDir, {
                projectTrusted: false,
            });
        const explicitTrust =
            resolve(input.cwd) === initialCwd
                ? options.isProjectTrusted
                : undefined;
        if (options.settingsManager) {
            if (
                explicitTrust !== undefined &&
                settingsManager.isProjectTrusted() !== explicitTrust
            )
                throw new GuardError(
                    "CONFLICTING_PROJECT_TRUST",
                    "Explicit project trust conflicts with the supplied settings manager",
                );
        } else {
            const storedTrust = new ProjectTrustStore(input.agentDir).get(
                input.cwd,
            );
            settingsManager.setProjectTrusted(
                explicitTrust ??
                    storedTrust ??
                    settingsManager.getDefaultProjectTrust() === "always",
            );
        }
        const guard = createGuardExtension({
            ...options,
            trustedExtensionPaths,
            cwd: input.cwd,
            agentDir: input.agentDir,
        });
        try {
            await guard.initialize();
            const external = (options.externalExtensions ?? []).map(
                (extension) =>
                    guardedExternalExtension(extension, () =>
                        guard.assertReady(),
                    ),
            );
            const services = await createAgentSessionServices({
                cwd: input.cwd,
                agentDir: input.agentDir,
                modelRuntime: options.modelRuntime,
                settingsManager,
                resourceLoaderOptions: {
                    additionalExtensionPaths: trustedExtensionPaths,
                    extensionFactories: [
                        {
                            name: "pi-codex-auto-review",
                            factory: guard.factory,
                        },
                        createCodemodeExtension({ models: false }),
                        ...external,
                        ...(options.trustedExtensions ?? []),
                    ],
                    noExtensions: true,
                    noContextFiles: true,
                    agentsFilesOverride: () => {
                        const controller = guard.assertReady();
                        return {
                            agentsFiles: loadContextFiles({
                                cwd: input.cwd,
                                agentDir: input.agentDir,
                                profile: controller.policy.profile,
                                settings: controller.options.settings,
                                isProjectTrusted:
                                    settingsManager.isProjectTrusted(),
                            }),
                        };
                    },
                },
            });
            const loaded = services.resourceLoader.getExtensions();
            if (
                loaded.errors.length ||
                services.diagnostics.some((item) => item.type === "error")
            )
                throw new GuardError(
                    "GUARDED_STARTUP_FAILED",
                    "An extension or runtime service failed to load",
                );
            guard.assertReady();
            const selectedModel = options.modelSelection
                ? services.modelRuntime.getModel(
                      options.modelSelection.provider,
                      options.modelSelection.id,
                  )
                : options.model;
            if (options.modelSelection && !selectedModel)
                throw new GuardError(
                    "MODEL_UNAVAILABLE",
                    `Registered model not found: ${options.modelSelection.provider}/${options.modelSelection.id}`,
                );
            // A fixed SDK `tools` list is a permanent allowlist and discards later MCP registrations.
            // Local tools still have final execution guards; other extension tools run as in Codex.
            const result = await createAgentSessionFromServices({
                services,
                sessionManager: input.sessionManager,
                model: selectedModel,
                sessionStartEvent: input.sessionStartEvent,
                excludeTools: ["powershell"],
            });
            await result.session.bindExtensions({ mode: "print" });
            guard.assertReady();
            const session = result.session;
            session.setActiveToolsByName(
                session
                    .getAllTools()
                    .filter((tool) =>
                        ["direct", "model-only"].includes(tool.exposure),
                    )
                    .map((tool) => tool.name),
            );
            const prompt = session.prompt.bind(session);
            session.prompt = async (...args) => {
                guard.assertReady();
                return prompt(...args);
            };
            const reload = session.reload.bind(session);
            session.reload = async (...args) => {
                await guard.close();
                await guard.initialize();
                await reload(...args);
                const controller = guard.assertReady();
                // Pi omits session_start after reload when print/SDK mode has no UI or command bindings.
                if (
                    !controller.isBoundToSession(
                        session.sessionManager.getSessionId(),
                    )
                ) {
                    await args[0]?.beforeSessionStart?.();
                    await session.extensionRunner.emit({
                        type: "session_start",
                        reason: "reload",
                    });
                }
                guard.assertReady();
            };
            const executeBash = session.executeBash.bind(session);
            session.executeBash = async (command, onChunk, options) => {
                const controller = guard.assertReady();
                if (!controller.options.settings.isEnabled)
                    return executeBash(command, onChunk, options);
                const handled = options?.operations
                    ? { operations: options.operations }
                    : await session.extensionRunner.emitUserBash({
                          type: "user_bash",
                          command,
                          cwd: session.sessionManager.getCwd(),
                          excludeFromContext:
                              options?.excludeFromContext ?? false,
                      });
                if (
                    !handled?.operations ||
                    !controller.isGuardedOperations(handled.operations)
                )
                    throw new GuardError(
                        "UNGUARDED_OPERATIONS",
                        "Protected sessions require guarded shell operations",
                    );
                return executeBash(command, onChunk, {
                    ...options,
                    operations: handled.operations,
                });
            };
            return { ...result, services, diagnostics: services.diagnostics };
        } catch (error) {
            try {
                await guard.close();
            } catch {}
            throw error;
        }
    };
    return createAgentSessionRuntime(createRuntime, {
        cwd: initialCwd,
        agentDir,
        sessionManager:
            options.sessionManager ??
            SessionManager.create(initialCwd, join(agentDir, "sessions")),
    });
}
