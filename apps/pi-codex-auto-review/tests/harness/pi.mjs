import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createGuardedRuntime } from "../../dist/startup.js";

let ai;
export async function hostAI() {
    if (ai) return ai;
    let dir = dirname(
        fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    );
    for (let i = 0; i < 8; i++) {
        try {
            const pkg = JSON.parse(
                await readFile(
                    join(
                        dir,
                        "node_modules/@earendil-works/pi-ai/package.json",
                    ),
                    "utf8",
                ),
            );
            if (pkg.name === "@earendil-works/pi-ai") {
                ai = await import(
                    pathToFileURL(
                        join(
                            dir,
                            "node_modules/@earendil-works/pi-ai/dist/index.js",
                        ),
                    ).href
                );
                return ai;
            }
        } catch {}
        dir = dirname(dir);
    }
    throw new Error("Host AI dependency unavailable");
}
export const FAKE_MODEL = {
    id: "fixture-model",
    name: "Fixture model",
    provider: "fixture",
    api: "openai-completions",
    baseUrl: "http://unused.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 2000,
};
export async function offlineModelRuntime(f) {
    const { InMemoryCredentialStore } = await hostAI();
    const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        authPath: join(f.agentDir, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(f.agentDir, "models-store.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    // The SDK normally probes every built-in provider during catalog refresh, including ADC paths.
    // This suite supplies one synthetic provider and does not discover host credentials or catalogs.
    runtime.refresh = async () => ({ aborted: false, errors: new Map() });
    runtime.registerProvider("fixture", {
        baseUrl: "http://unused.invalid",
        api: "openai-completions",
        apiKey: "synthetic-fixture-key",
        models: [
            {
                id: FAKE_MODEL.id,
                name: FAKE_MODEL.name,
                reasoning: false,
                input: ["text"],
                cost: FAKE_MODEL.cost,
                contextWindow: FAKE_MODEL.contextWindow,
                maxTokens: FAKE_MODEL.maxTokens,
            },
        ],
    });
    return runtime;
}
export async function guardedFixture(t, f, options = {}) {
    const modelRuntime = await offlineModelRuntime(f);
    const runtime = await createGuardedRuntime({
        cwd: f.workspace,
        agentDir: f.agentDir,
        modelRuntime,
        model: FAKE_MODEL,
        settingsManager: SettingsManager.inMemory({
            cacheWarming: "off",
            compaction: { enabled: false },
            quietStartup: true,
        }),
        sessionManager: SessionManager.inMemory(f.workspace),
        profile: f.profile,
        provider: {
            complete: async () =>
                '{"decision":"allow","reason":"fixture-authorized"}',
        },
        ...options,
    });
    t.after(async () => {
        await runtime.dispose();
    });
    return runtime;
}
export async function planStream(session, calls) {
    const { createAssistantMessageEventStream } = await hostAI();
    let invocation = 0;
    session.agent.streamFunction = async () => {
        const stream = createAssistantMessageEventStream(),
            next = calls[invocation++] ?? [];
        const message = {
            role: "assistant",
            api: FAKE_MODEL.api,
            provider: FAKE_MODEL.provider,
            model: FAKE_MODEL.id,
            content: next.length
                ? next.map((call, i) => ({
                      type: "toolCall",
                      id: `fixture-${invocation}-${i}`,
                      name: call.name,
                      arguments: call.args,
                  }))
                : [{ type: "text", text: "fixture complete" }],
            usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                },
            },
            stopReason: next.length ? "toolUse" : "stop",
            timestamp: Date.now(),
        };
        queueMicrotask(() => {
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: message.stopReason, message });
            stream.end(message);
        });
        return stream;
    };
}
