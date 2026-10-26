import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import codexMemory from "../../dist/index.js";
import { attachBudget } from "./budget.mjs";

export const TARGETS = [
    {
        key: "sol",
        provider: "openai-codex",
        id: "gpt-6.1-sol",
        reasoning: "medium",
    },
    {
        key: "luna",
        provider: "openai-codex",
        id: "gpt-6-luna",
        reasoning: "high",
    },
    {
        key: "glm",
        provider: "ollama-cloud",
        id: "glm-5.3-flash",
        reasoning: "high",
    },
    {
        key: "deepseek",
        provider: "ollama-cloud",
        id: "deepseek-v4.1-flash",
        reasoning: "high",
    },
    { key: "sonnet", provider: "claude-bridge", id: "claude-sonnet-5-5" },
    { key: "haiku", provider: "claude-bridge", id: "claude-haiku-5-5" },
    { key: "swe", provider: "devin", id: "swe-2", reasoning: "high" },
];
export const REVIEWER = {
    key: "astra",
    provider: "openai-codex",
    id: "gpt-6-astra",
    reasoning: "high",
};
const providerPackages = {
    "claude-bridge": "pi-claude-bridge",
    "ollama-cloud": "pi-ollama-cloud",
    devin: "pi-devin",
};

export async function privateJSON(path, value) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
    });
}
export async function discoverProviderPaths(cwd) {
    // Discovery only: do not bind or start unrelated extensions.
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir(),
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    const paths = {};
    for (const [provider, packageName] of Object.entries(providerPackages)) {
        const matches = result.extensions.filter((extension) =>
            extension.path.includes(packageName),
        );
        if (matches.length !== 1)
            throw new Error(
                `Expected one installed provider extension for ${provider}; got ${matches.length}.`,
            );
        paths[provider] = matches[0].path;
    }
    return paths;
}
export async function liveSession({
    cwd,
    providerPaths,
    target,
    memoryAgentDir,
    includeMemory = false,
    onError = () => {},
    sessionManager,
    settingsOverrides = {},
    extensionFactories = [],
    budgetMaximum = 80,
    memoryFactory = codexMemory,
}) {
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    if (memoryAgentDir)
        await mkdir(memoryAgentDir, { recursive: true, mode: 0o700 });
    const agentDir = getAgentDir();
    // Resolve credentials through Pi. Never copy or print auth.json or credential values.
    const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    attachBudget(modelRuntime, { maximum: budgetMaximum });
    const settingsManager = SettingsManager.inMemory({
        cacheWarming: "off",
        compaction: { enabled: false },
        quietStartup: true,
        defaultProvider: target.provider,
        defaultModel: target.id,
        providerRetry: { maxRetries: 0, timeoutMs: 120000 },
        defaultTools: [],
        ...settingsOverrides,
    });
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: providerPaths[target.provider]
            ? [providerPaths[target.provider]]
            : [],
        extensionFactories: [
            ...(includeMemory
                ? [(pi) => memoryFactory(pi, { agentDir: memoryAgentDir })]
                : []),
            ...extensionFactories,
        ],
    });
    await resourceLoader.reload();
    const { session, extensionsResult } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        settingsManager,
        resourceLoader,
        sessionManager: sessionManager ?? SessionManager.inMemory(cwd),
        tools: includeMemory
            ? [
                  "pi_codex_memory_list",
                  "pi_codex_memory_search",
                  "pi_codex_memory_read",
              ]
            : [],
        thinkingLevel: target.reasoning ?? "medium",
    });
    if (extensionsResult.errors.length)
        throw new Error(
            `Provider extension load failed: ${extensionsResult.errors.map((error) => error.error).join("; ")}`,
        );
    await session.bindExtensions({ mode: "print", onError });
    const ctx = session.extensionRunner.createContext();
    // Native providers such as Devin restore their account-scoped catalog at refresh.
    await ctx.modelRegistry.refresh({
        providers: [target.provider],
        allowNetwork: false,
    });
    let model = ctx.modelRegistry.find(target.provider, target.id);
    if (!model && providerPaths[target.provider]) {
        await ctx.modelRegistry.refresh({
            providers: [target.provider],
            allowNetwork: true,
        });
        model = ctx.modelRegistry.find(target.provider, target.id);
    }
    if (!model) {
        await disposeSession(session);
        throw new Error(
            `Exact model not registered: ${target.provider}/${target.id}`,
        );
    }
    const levels = getSupportedThinkingLevels(model);
    if (target.reasoning && !levels.includes(target.reasoning)) {
        await disposeSession(session);
        throw new Error(
            `Requested reasoning ${target.reasoning} unsupported: ${target.provider}/${target.id}`,
        );
    }
    await session.setModel(model);
    if (target.reasoning) session.setThinkingLevel(target.reasoning);
    if (includeMemory)
        session.setActiveToolsByName([
            "pi_codex_memory_list",
            "pi_codex_memory_search",
            "pi_codex_memory_read",
        ]);
    return { session, ctx, model, levels, modelRuntime, settingsManager };
}
export async function disposeSession(session) {
    try {
        await session.extensionRunner.emit({ type: "session_shutdown" });
    } finally {
        session.dispose();
    }
}

if (process.argv[2] === "inspect") {
    const root = resolve(process.argv[3]);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const providerPaths = await discoverProviderPaths(process.cwd());
    await privateJSON(join(root, "provider-paths.json"), providerPaths);
    const catalog = [];
    for (const target of [...TARGETS, REVIEWER]) {
        const active = await liveSession({
            cwd: join(root, "preflight", target.key),
            providerPaths,
            target,
        });
        catalog.push({
            ...target,
            api: active.model.api,
            supportedReasoning: active.levels,
            nativeReasoningMap: active.model.thinkingLevelMap ?? null,
            contextWindow: active.model.contextWindow,
            maxTokens: active.model.maxTokens,
            configuredAuthentication:
                active.ctx.modelRegistry.hasConfiguredAuth(active.model),
        });
        await disposeSession(active.session);
        await privateJSON(join(root, "catalog.json"), catalog);
    }
    console.log(JSON.stringify({ providerPaths, catalog }, null, 2));
}
