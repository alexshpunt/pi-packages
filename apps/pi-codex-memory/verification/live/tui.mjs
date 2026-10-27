import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    getAgentDir,
    InteractiveMode,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../dist/config.js";
import memory from "../../dist/index.js";
import { createMemoryMasker } from "../../dist/safety.js";
import { MemoryStore } from "../../dist/store.js";
import { attachBudget } from "./budget.mjs";

const root = resolve(process.argv[2]),
    phase = process.argv[3] ?? "seed";
const plan = JSON.parse(await readFile(join(root, "case.json"), "utf8"));
const cwd = plan.cwd,
    agentDir = join(root, phase === "control" ? "control-agent" : "agent");
const authDir = getAgentDir();
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(agentDir, { recursive: true, mode: 0o700 });
await mkdir(cwd, { recursive: true, mode: 0o700 });
const providerPaths = JSON.parse(await readFile(plan.providerPaths, "utf8"));
const mask = createMemoryMasker();
let requestNumber = 0,
    foregroundCalls = 0;
const logPath = join(root, `${phase}-events.jsonl`);
const log = (value) =>
    appendFileSync(
        logPath,
        `${JSON.stringify(value, (_key, item) =>
            typeof item === "string" ? mask(item) : item,
        )}\n`,
        { mode: 0o600 },
    );
let TargetMemoryStore = MemoryStore;
if (plan.packagePath) {
    let packageRoot = resolve(plan.packagePath);
    if (!(await stat(packageRoot)).isDirectory())
        packageRoot = dirname(packageRoot);
    while (true) {
        let metadata;
        try {
            metadata = JSON.parse(
                await readFile(join(packageRoot, "package.json"), "utf8"),
            );
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        if (metadata) {
            if (
                !["@buyong/pi-codex-memory", "@buyong/pi-codex"].includes(
                    metadata.name,
                )
            )
                throw new Error("Expected a memory package or Codex bundle.");
            const memoryRoot =
                metadata.name === "@buyong/pi-codex"
                    ? join(packageRoot, "node_modules/@buyong/pi-codex-memory")
                    : packageRoot;
            TargetMemoryStore = (
                await import(pathToFileURL(join(memoryRoot, "dist/store.js")))
            ).MemoryStore;
            break;
        }
        const parent = dirname(packageRoot);
        if (parent === packageRoot)
            throw new Error("Memory package manifest not found.");
        packageRoot = parent;
    }
}
const store = new TargetMemoryStore(join(agentDir, "pi-codex-memory"));
const scope = store.scopeFor(cwd);
if (phase === "seed")
    store.saveSettings(scope, {
        ...DEFAULT_SETTINGS,
        useMemories: true,
        generateMemories: true,
        extractModel: { provider: "claude-bridge", id: "claude-haiku-5-5" },
        consolidateModel: { provider: "claude-bridge", id: "claude-haiku-5-5" },
        minIdleMs: 60000,
        consolidationCooldownMs: 60000,
        pollIntervalMs: 1000,
        maxRolloutsPerRun: 1,
        maxAttempts: 2,
        retryDelayMs: 1000,
    });
if (phase === "lifecycle")
    store.saveSettings(scope, {
        ...store.getSettings(scope),
        generateMemories: false,
    });
store.close();

const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const modelRuntime = await ModelRuntime.create({
        authPath: join(authDir, "auth.json"),
        modelsPath: join(authDir, "models.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    attachBudget(modelRuntime);
    const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
    modelRuntime.streamSimple = (model, context, options) => {
        const system = context.systemPrompt ?? "";
        const kind = system.startsWith("You are part of an agent memory")
            ? "extraction"
            : system.startsWith("Consolidate")
              ? "consolidation"
              : "foreground";
        if (kind === "foreground" && ++foregroundCalls > 4)
            throw new Error("TUI_FOREGROUND_REQUEST_LIMIT");
        if (
            phase === "control" &&
            JSON.stringify(context).includes(plan.marker)
        )
            throw new Error("CONTROL_INPUT_LEAK");
        const requestId = ++requestNumber;
        log({
            event: "model_request",
            requestId,
            kind,
            model: model.id,
            reasoning: options?.reasoning,
            context,
            options: {
                maxTokens: options?.maxTokens,
                cacheRetention: options?.cacheRetention,
                sessionId: options?.sessionId,
            },
        });
        const stream = streamSimple(model, context, {
            ...options,
            maxTokens: options?.maxTokens ?? 4096,
            maxRetries: 0,
        });
        const result = stream.result.bind(stream);
        stream.result = async () => {
            const response = await result();
            log({
                event: "model_result",
                requestId,
                kind,
                stopReason: response.stopReason,
                text: response.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n"),
                usage: response.usage,
            });
            return response;
        };
        return stream;
    };
    const proof = (pi) => {
        pi.on("session_start", (_event, ctx) =>
            log({
                event: "session_start",
                mode: ctx.mode,
                sessionId: ctx.sessionManager.getSessionId(),
                file: ctx.sessionManager.getSessionFile(),
            }),
        );
        pi.on("before_agent_start", () => {
            foregroundCalls = 0;
        });
        pi.on("message_end", (event, ctx) => {
            if (event.message.role === "assistant")
                log({
                    event: "assistant",
                    sessionId: ctx.sessionManager.getSessionId(),
                    stopReason: event.message.stopReason,
                    text: event.message.content
                        .filter((part) => part.type === "text")
                        .map((part) => part.text)
                        .join("\n"),
                });
        });
        pi.on("tool_execution_start", (event) =>
            log({
                event: "tool_start",
                name: event.toolName,
                id: event.toolCallId,
                args: event.args,
            }),
        );
        pi.on("tool_execution_end", (event) =>
            log({
                event: "tool_end",
                name: event.toolName,
                id: event.toolCallId,
                isError: event.isError,
                result: event.result,
            }),
        );
        pi.on("agent_settled", (event, ctx) =>
            log({
                event: "settled",
                aborted: event.aborted,
                sessionId: ctx.sessionManager.getSessionId(),
            }),
        );
        pi.on("session_shutdown", () => log({ event: "shutdown" }));
    };
    const tools = [
        "pi_codex_memory_list",
        "pi_codex_memory_read",
        "pi_codex_memory_search",
        "pi_codex_memory_note",
    ];
    const settingsManager = SettingsManager.inMemory({
        cacheWarming: "off",
        compaction: { enabled: false },
        quietStartup: false,
        defaultProvider: "openai-codex",
        defaultModel: "gpt-6.1-sol",
        defaultTools: tools,
        providerRetry: { maxRetries: 0, timeoutMs: 120000 },
    });
    const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime,
        settingsManager,
        resourceLoaderOptions: {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            additionalExtensionPaths: [
                providerPaths["claude-bridge"],
                ...(plan.packagePath ? [plan.packagePath] : []),
            ],
            extensionFactories: [
                ...(plan.packagePath ? [] : [(pi) => memory(pi, { agentDir })]),
                proof,
            ],
        },
    });
    const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        thinkingLevel: "medium",
        tools,
    });
    await created.session.bindExtensions({
        mode: "print",
        onError: (error) =>
            log({
                event: "extension_error",
                error: String(error.error ?? error),
            }),
    });
    const model = created.session.extensionRunner
        .createContext()
        .modelRegistry.find("openai-codex", "gpt-6.1-sol");
    if (!model) throw new Error("Requested TUI model unavailable.");
    await created.session.setModel(model);
    created.session.setThinkingLevel("medium");
    created.session.subscribe((event) => {
        if (
            event.type === "message_end" &&
            event.message.customType === "pi-codex-memory.status"
        )
            log({ event: "memory_status", value: event.message.content });
    });
    return { ...created, services, diagnostics: services.diagnostics };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, join(agentDir, "sessions")),
});
writeFileSync(
    join(root, `${phase}-boot.json`),
    JSON.stringify({ cwd, agentDir, scope, model: runtime.session.model?.id }),
    { mode: 0o600 },
);
try {
    await new InteractiveMode(runtime, { verbose: true }).run();
} finally {
    await runtime.dispose();
}
