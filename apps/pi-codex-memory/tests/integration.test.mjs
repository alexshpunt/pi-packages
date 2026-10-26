import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    createAssistantMessageEventStream,
    InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { modeCommand } from "../dist/commands.js";
import { DEFAULT_SETTINGS } from "../dist/config.js";
import extension from "../dist/index.js";
import { EMPTY_SUMMARY } from "../dist/pipeline.js";
import { MemoryRuntime } from "../dist/runtime.js";
import { workspaceScope } from "../dist/safety.js";
import { settingsCommand } from "../dist/settings-commands.js";
import { MemoryStore } from "../dist/store.js";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
async function directory(t) {
    const root = await mkdtemp(join(tmpdir(), "pi-memory-integration-"));
    const agentDir = join(root, "agent"),
        cwd = join(root, "work");
    await mkdir(agentDir);
    await mkdir(cwd);
    t.after(async () => {
        await rm(root, { recursive: true, force: true });
    });
    return { root, agentDir, cwd };
}
function fakeContext(f, ui = {}) {
    return {
        cwd: f.cwd,
        mode: "print",
        hasUI: false,
        ui: { notify() {}, ...ui },
        sessionManager: SessionManager.inMemory(f.cwd),
        modelRegistry: { getAvailable: () => [] },
        isIdle: () => true,
    };
}
test("three argument-free memory commands are registered; tools validate disabled access, consent and abort", async (t) => {
    const f = await directory(t);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = f.agentDir;
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    });
    const tools = new Map(),
        commands = new Map(),
        handlers = new Map(),
        messages = [];
    extension({
        registerTool: (tool) => tools.set(tool.name, tool),
        registerCommand: (name, command) => commands.set(name, command),
        on: (name, handler) => handlers.set(name, handler),
        appendEntry() {},
        sendMessage: (message) => messages.push(message),
    });
    assert.deepEqual(
        [...commands.keys()],
        ["codex-memory", "codex-memory-manage", "codex-memory-settings"],
    );
    assert.deepEqual([...tools.keys()].sort(), [
        "pi_codex_memory_list",
        "pi_codex_memory_note",
        "pi_codex_memory_read",
        "pi_codex_memory_search",
    ]);
    const ctx = fakeContext(f);
    await handlers.get("session_start")({}, ctx);
    await commands.get("codex-memory").handler("", ctx);
    assert.match(messages[0].content, /generateMemories/);
    const list = await tools
        .get("pi_codex_memory_list")
        .execute("list", {}, undefined, undefined, ctx);
    assert.deepEqual(list.details.entries, []);
    await assert.rejects(
        tools
            .get("pi_codex_memory_note")
            .execute(
                "note",
                { filename: "test.md", note: "remember me" },
                undefined,
                undefined,
                ctx,
            ),
        /not confirmed/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        tools
            .get("pi_codex_memory_list")
            .execute("list", {}, controller.signal, undefined, ctx),
    );
    ctx.hasUI = true;
    ctx.ui.confirm = async () => true;
    const note = await tools
        .get("pi_codex_memory_note")
        .execute(
            "note",
            { filename: "test.md", note: "remember scoped result" },
            undefined,
            undefined,
            ctx,
        );
    assert.equal(note.details.path, "extensions/ad_hoc/notes/test.md");
    await handlers.get("before_agent_start")({}, ctx);
    const event = {
        messages: [{ role: "user", content: "current prompt", timestamp: 1 }],
    };
    const injected = await handlers.get("context")(event, ctx);
    assert.equal(injected.messages.length, 2);
    assert.equal(event.messages.length, 1);
    assert.match(
        injected.messages[0].content[0].text,
        /remember scoped result/,
    );
    assert.equal(
        ctx.sessionManager.getEntries().length,
        0,
        "injection is not persisted",
    );
    const external = new MemoryStore(join(f.agentDir, "pi-codex-memory"));
    external.revise(workspaceScope(f.cwd), note.details.path, null);
    external.close();
    assert.equal(
        await handlers.get("context")(event, ctx),
        undefined,
        "cross-process forgetting invalidates an active request snapshot",
    );
    let closeMenu;
    const notices = [];
    ctx.waitForIdle = async () => {};
    ctx.ui.notify = (message) => notices.push(message);
    ctx.ui.select = () =>
        new Promise((resolve) => {
            closeMenu = resolve;
        });
    const openMenu = commands.get("codex-memory").handler("", ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const firstClose = closeMenu;
    await commands.get("codex-memory-manage").handler("", ctx);
    assert.deepEqual(notices, ["A memory menu is already open."]);
    assert.equal(closeMenu, firstClose, "a second menu does not open");
    closeMenu("Close");
    await openMenu;
    await handlers.get("session_shutdown")();
    await handlers.get("session_start")({}, ctx);
    assert.equal(
        (
            await tools
                .get("pi_codex_memory_list")
                .execute("list", {}, undefined, undefined, ctx)
        ).details.entries.length,
        0,
    );
    await handlers.get("session_shutdown")();
});
test("TUI extraction returns control; reopening the menu keeps it running and Stop interrupts that exact request", async (t) => {
    const f = await directory(t),
        handlers = new Map(),
        commands = new Map(),
        messages = [];
    extension(
        {
            registerTool() {},
            registerCommand: (name, value) => commands.set(name, value),
            on: (name, handler) => handlers.set(name, handler),
            appendEntry() {},
            sendMessage: (message) => messages.push(message),
        },
        { agentDir: f.agentDir },
    );
    let seen;
    const ctx = {
        ...fakeContext(f, { confirm: async () => true }),
        mode: "tui",
        hasUI: true,
        waitForIdle: async () => {},
        modelRegistry: {
            find: (provider, id) => ({ provider, id }),
            streamSimple(_model, _context, options) {
                seen = options.signal;
                return {
                    result: () =>
                        new Promise((_resolve, reject) =>
                            options.signal.addEventListener(
                                "abort",
                                () => reject(options.signal.reason),
                                { once: true },
                            ),
                        ),
                };
            },
        },
    };
    ctx.sessionManager.appendMessage({
        role: "user",
        content: "A real source for cancellation.",
        timestamp: Date.now(),
    });
    const store = new MemoryStore(join(f.agentDir, "pi-codex-memory"));
    store.saveSettings(workspaceScope(f.cwd), {
        ...DEFAULT_SETTINGS,
        generateMemories: true,
        extractModel: { provider: "fixture", id: "extract" },
        consolidateModel: { provider: "fixture", id: "consolidate" },
    });
    await handlers.get("session_start")({}, ctx);
    const notices = [],
        statuses = [];
    ctx.ui.notify = (message) => notices.push(message);
    ctx.ui.setStatus = (_key, text) => statuses.push(text);
    ctx.ui.select = async (_title, rows) => {
        assert.ok(rows.includes("Generate from this conversation"));
        return "Generate from this conversation";
    };
    await commands.get("codex-memory-manage").handler("", ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(notices[0], /Creating memories/);
    assert.ok(seen && !seen.aborted);
    const picks = ["Stop current job", "Close"];
    ctx.ui.select = async (_title, rows) => {
        const pick = picks.shift();
        assert.ok(rows.includes(pick));
        if (pick === "Stop current job")
            assert.equal(
                seen.aborted,
                false,
                "opening the menu does not cancel",
            );
        return pick;
    };
    await commands.get("codex-memory-manage").handler("", ctx);
    assert.equal(seen.aborted, true);
    assert.ok(notices.includes("Stopped the memory job."));
    assert.equal(messages.length, 0);
    assert.ok(statuses.includes("Memory: Use and create · updating…"));
    assert.equal(
        statuses.at(-1),
        "Memory: Use and create",
        "a stopped job is not reported as a failure",
    );
    assert.equal(
        store
            .status(workspaceScope(f.cwd))
            .jobs.find((job) => job.key.startsWith("extract:")).status,
        "cancelled",
    );
    assert.equal(store.records(workspaceScope(f.cwd)).length, 0);
    await handlers.get("session_shutdown")();
    store.close();
});
test("the mode menu turns creation on with one model after consent; declining saves nothing", async (t) => {
    const f = await directory(t);
    const ctx = fakeContext(f, { confirm: async () => false });
    ctx.hasUI = true;
    ctx.modelRegistry = {
        getAvailable: () => [{ provider: "fixture", id: "local" }],
    };
    ctx.ui.select = async (_title, rows) =>
        rows.find((row) => row.endsWith("Use and create memories")) ??
        "fixture/local";
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    const options = { ctx, runtime, show() {} };
    await modeCommand(options);
    assert.equal(runtime.settings().generateMemories, false);
    assert.equal(runtime.settings().extractModel, null);
    ctx.ui.confirm = async () => true;
    await modeCommand(options);
    const model = { provider: "fixture", id: "local" };
    assert.deepEqual(runtime.settings().extractModel, model);
    assert.deepEqual(runtime.settings().consolidateModel, model);
    assert.equal(runtime.settings().generateMemories, true);
    ctx.ui.select = async (_title, rows) =>
        rows.find((row) => row.endsWith("Off"));
    await modeCommand(options);
    assert.equal(runtime.settings().useMemories, false);
    assert.equal(runtime.settings().generateMemories, false);
    await runtime.dispose();
});
test("changing the model while creation is on asks for consent again; declining keeps the old model", async (t) => {
    const f = await directory(t);
    const before = { provider: "fixture", id: "local" },
        after = { provider: "fixture", id: "other" };
    const store = new MemoryStore(join(f.agentDir, "pi-codex-memory"));
    store.saveSettings(workspaceScope(f.cwd), {
        ...DEFAULT_SETTINGS,
        generateMemories: true,
        extractModel: before,
        consolidateModel: before,
    });
    store.close();
    let consents = 0,
        isAccepted = false,
        pick;
    const ctx = fakeContext(f, {
        confirm: async () => {
            consents++;
            return isAccepted;
        },
        select: async (_title, rows) => {
            const choice = pick
                ? rows.find((row) => row.startsWith(pick))
                : "Close";
            pick = choice?.startsWith("Model") ? "fixture/other" : undefined;
            return choice;
        },
    });
    ctx.hasUI = true;
    ctx.modelRegistry = { getAvailable: () => [before, after] };
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    const options = { ctx, runtime, show() {}, changeScope: async () => {} };
    pick = "Model";
    await settingsCommand(options);
    assert.equal(consents, 1);
    assert.deepEqual(runtime.settings().extractModel, before);
    isAccepted = true;
    pick = "Model";
    await settingsCommand(options);
    assert.equal(consents, 2);
    assert.deepEqual(runtime.settings().extractModel, after);
    assert.deepEqual(runtime.settings().consolidateModel, after);
    await runtime.dispose();
});
test("settings rows save immediately in their units; rejected input and cancelled JSON save nothing", async (t) => {
    const f = await directory(t);
    const notices = [];
    const ctx = fakeContext(f, {
        notify: (message) => notices.push(message),
        confirm: async () => true,
    });
    ctx.hasUI = true;
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    const options = { ctx, runtime, show() {}, changeScope: async () => {} };
    let pick;
    ctx.ui.select = async (_title, rows) => {
        const choice = pick
            ? rows.find((row) => row.startsWith(pick))
            : "Close";
        pick = undefined;
        return choice;
    };
    pick = "Idle time";
    ctx.ui.input = async (_title, value) => {
        assert.equal(value, "30");
        return "45";
    };
    await settingsCommand(options);
    assert.equal(runtime.settings().minIdleMs, 45 * 60_000);
    pick = "Idle time";
    ctx.ui.input = async () => "0";
    await settingsCommand(options);
    assert.equal(runtime.settings().minIdleMs, 45 * 60_000);
    assert.match(notices.at(-1), /from 1 to 2880 minutes/);
    pick = "Edit all settings as JSON";
    ctx.ui.editor = async () => undefined;
    await settingsCommand(options);
    pick = "Edit all settings as JSON";
    ctx.ui.editor = async (_title, text) =>
        JSON.stringify({ ...JSON.parse(text), generateMemories: true });
    await settingsCommand(options);
    assert.equal(runtime.settings().generateMemories, false);
    assert.match(notices.at(-1), /Select extraction and consolidation models/);
    pick = "Edit all settings as JSON";
    ctx.ui.editor = async (_title, text) =>
        JSON.stringify({ ...JSON.parse(text), useMemories: false });
    await settingsCommand(options);
    assert.equal(runtime.settings().useMemories, false);
    assert.equal(runtime.settings().minIdleMs, 45 * 60_000);
    await runtime.dispose();
});
test("real Pi SDK loads extension, executes tools and commands, and receives ephemeral memory context", async (t) => {
    const f = await directory(t);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = f.agentDir;
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    });
    const settingsManager = SettingsManager.inMemory({
        cacheWarming: "off",
        compaction: { enabled: false },
        quietStartup: true,
    });
    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        modelsStorePath: join(f.agentDir, "models.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    modelRuntime.refresh = async () => ({ aborted: false, errors: new Map() });
    modelRuntime.registerProvider("fixture", {
        baseUrl: "http://unused.invalid",
        api: "openai-completions",
        apiKey: "synthetic-fixture-key",
        models: [
            {
                id: "local",
                name: "Local fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 100000,
                maxTokens: 4096,
            },
        ],
    });
    const model = modelRuntime.getModel("fixture", "local");
    assert.ok(model);
    const loader = new DefaultResourceLoader({
        cwd: f.cwd,
        agentDir: f.agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [packageDir],
    });
    await loader.reload();
    assert.equal(loader.getExtensions().errors.length, 0);
    const { session } = await createAgentSession({
        cwd: f.cwd,
        agentDir: f.agentDir,
        settingsManager,
        modelRuntime,
        model,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(f.cwd),
        noTools: true,
    });
    t.after(async () => {
        await session.extensionRunner.emit({ type: "session_shutdown" });
        session.dispose();
    });
    const errors = [];
    await session.bindExtensions({
        mode: "print",
        onError: (error) => errors.push(error),
    });
    const store = new MemoryStore(join(f.agentDir, "pi-codex-memory"));
    store.addNote(
        workspaceScope(f.cwd),
        "Only use this local fixture's scoped history.",
    );
    store.close();
    const seen = [];
    let invocation = 0;
    session.agent.streamFunction = async (_model, context) => {
        seen.push(context);
        const stream = createAssistantMessageEventStream();
        const content =
            invocation++ === 0
                ? [
                      {
                          type: "toolCall",
                          id: "memory-list",
                          name: "pi_codex_memory_list",
                          arguments: {},
                      },
                  ]
                : [{ type: "text", text: "local fixture complete" }];
        const message = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content,
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
            stopReason: invocation === 1 ? "toolUse" : "stop",
            timestamp: Date.now(),
        };
        queueMicrotask(() => {
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: message.stopReason, message });
            stream.end(message);
        });
        return stream;
    };
    await session.prompt("/codex-memory status");
    await session.prompt("List the scoped memory files.");
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.ok(seen.length >= 2);
    assert.ok(
        seen.every((context) =>
            JSON.stringify(context.messages).includes("CODEX_MEMORY_V2"),
        ),
    );
    assert.ok(
        seen.every(
            (context) =>
                (
                    JSON.stringify(context.messages).match(
                        /CODEX_MEMORY_V2/g,
                    ) ?? []
                ).length === 1,
        ),
    );
    const memoryMessage = seen[0].messages.find((message) =>
        JSON.stringify(message.content).includes("CODEX_MEMORY_V2"),
    );
    assert.ok(
        Buffer.byteLength(memoryMessage.content[0].text) <=
            DEFAULT_SETTINGS.maxInjectionBytes,
    );
    const results = session.messages.filter(
        (message) =>
            message.role === "toolResult" &&
            message.toolName === "pi_codex_memory_list",
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, false);
    assert.ok(
        !JSON.stringify(session.sessionManager.getEntries()).includes(
            "CODEX_MEMORY_V2",
        ),
        "request context must not enter persisted entries",
    );
    const nested = [];
    modelRuntime.registerProvider("fixture", {
        baseUrl: "http://unused.invalid",
        api: "openai-completions",
        apiKey: "synthetic-fixture-key",
        models: [
            {
                id: "local",
                name: "Local fixture",
                reasoning: false,
                input: ["text"],
                cost: model.cost,
                contextWindow: 100000,
                maxTokens: 4096,
            },
        ],
        streamSimple(nestedModel, context, options) {
            nested.push({ context: structuredClone(context), options });
            const user = context.messages.find(
                (message) => message.role === "user",
            );
            const input = JSON.parse(
                typeof user.content === "string"
                    ? user.content
                    : user.content
                          .filter((part) => part.type === "text")
                          .map((part) => part.text)
                          .join("\n"),
            );
            const output =
                "rendered_conversation" in input
                    ? {
                          rollout_summary:
                              "The user asked to list memory; the tool completed locally.",
                          rollout_slug: "listing",
                      }
                    : {
                          memory_summary:
                              EMPTY_SUMMARY +
                              input.documents
                                  .map(
                                      (document) =>
                                          `- ${document.path} — prior evidence; thread_id=${document.thread_id}`,
                                  )
                                  .join("\n"),
                      };
            const stream = createAssistantMessageEventStream();
            const message = {
                role: "assistant",
                api: nestedModel.api,
                provider: nestedModel.provider,
                model: nestedModel.id,
                content: [{ type: "text", text: JSON.stringify(output) }],
                usage: {
                    input: 5,
                    output: 5,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 10,
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                    },
                },
                stopReason: "stop",
                timestamp: Date.now(),
            };
            queueMicrotask(() => {
                stream.push({ type: "start", partial: message });
                stream.push({ type: "done", reason: "stop", message });
                stream.end(message);
            });
            return stream;
        },
    });
    const configured = new MemoryStore(join(f.agentDir, "pi-codex-memory"));
    configured.saveSettings(workspaceScope(f.cwd), {
        ...DEFAULT_SETTINGS,
        generateMemories: true,
        extractModel: { provider: "fixture", id: "local" },
        consolidateModel: { provider: "fixture", id: "local" },
    });
    configured.close();
    await session.bindExtensions({
        mode: "rpc",
        uiContext: {
            notify() {},
            setStatus() {},
            setWidget() {},
            confirm: async () => true,
            select: async (_title, rows) =>
                rows.includes("Generate from this conversation")
                    ? "Generate from this conversation"
                    : "Close",
        },
        onError: (error) => errors.push(error),
    });
    await session.prompt("/codex-memory-manage");
    assert.equal(
        nested.length,
        2,
        "both model stages traverse the real Pi ModelRegistry",
    );
    assert.equal(nested[0].options.maxTokens, 4096);
    assert.equal(nested[0].options.signal.aborted, false);
    assert.equal(nested[0].options.cacheRetention, "none");
    assert.equal(
        nested[0].options.sessionId,
        session.sessionManager.getSessionId(),
    );
    assert.ok(
        !JSON.stringify(nested[0].context.messages).includes("CODEX_MEMORY_V2"),
    );
    const completed = new MemoryStore(join(f.agentDir, "pi-codex-memory"));
    assert.equal(
        completed
            .records(workspaceScope(f.cwd))
            .filter((record) => record.kind === "rollout").length,
        1,
    );
    assert.match(
        completed.state(workspaceScope(f.cwd)).summary,
        /rollout_summaries/,
    );
    completed.close();
    assert.equal(errors.length, 0, JSON.stringify(errors));
});
test("background scheduler waits for foreground idle, runs both stages and releases on shutdown", async (t) => {
    const f = await directory(t);
    const sessionDir = join(f.root, "sessions");
    await mkdir(sessionDir);
    const at = Date.now() - 3_600_000;
    const history = [
        {
            type: "session",
            version: 3,
            id: "historical-auto",
            cwd: f.cwd,
            timestamp: new Date(at).toISOString(),
        },
        {
            type: "custom",
            id: "origin",
            parentId: null,
            timestamp: new Date(at).toISOString(),
            customType: "pi-codex-memory.origin",
            data: { isInteractiveRoot: true },
        },
        {
            type: "message",
            id: "user",
            parentId: "origin",
            timestamp: new Date(at).toISOString(),
            message: {
                role: "user",
                content: "background task evidence",
                timestamp: at,
            },
        },
    ];
    const path = join(sessionDir, "historical.jsonl");
    await writeFile(
        path,
        `${history.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await utimes(path, at / 1000, at / 1000);
    let isIdle = false,
        calls = 0;
    const ctx = {
        ...fakeContext(f),
        mode: "rpc",
        sessionManager: SessionManager.create(f.cwd, sessionDir),
        isIdle: () => isIdle,
        modelRegistry: {
            find: (provider, id) => ({ provider, id }),
            streamSimple(_model, context) {
                calls++;
                const input = JSON.parse(context.messages[0].content[0].text);
                const output =
                    "rendered_conversation" in input
                        ? {
                              rollout_summary:
                                  "A background task was requested.",
                              rollout_slug: "background",
                          }
                        : {
                              memory_summary:
                                  EMPTY_SUMMARY +
                                  input.documents
                                      .map(
                                          (document) =>
                                              `- ${document.path} — background task`,
                                      )
                                      .join("\n"),
                          };
                return {
                    async result() {
                        return {
                            stopReason: "stop",
                            content: [
                                { type: "text", text: JSON.stringify(output) },
                            ],
                        };
                    },
                };
            },
        },
    };
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    t.after(async () => {
        await runtime.dispose();
    });
    runtime.store.saveSettings(runtime.scope, {
        ...DEFAULT_SETTINGS,
        pollIntervalMs: 1000,
        generateMemories: true,
        extractModel: { provider: "fixture", id: "extract" },
        consolidateModel: { provider: "fixture", id: "consolidate" },
    });
    runtime.start();
    runtime.busy();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(calls, 0);
    isIdle = true;
    runtime.settled();
    const deadline = Date.now() + 5000;
    while (!runtime.store.state(runtime.scope).summary && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(calls, 2);
    assert.equal(runtime.store.records(runtime.scope).length, 1);
    assert.equal(runtime.status().isRunning, false);
    await runtime.dispose();
});
test("shutdown closes storage even when activity cleanup fails", async (t) => {
    const f = await directory(t),
        runtime = new MemoryRuntime(fakeContext(f), f.agentDir);
    runtime.store.releaseActivity = () => {
        throw new Error("cleanup unavailable");
    };
    await assert.rejects(runtime.dispose(), /cleanup unavailable/);
    assert.throws(() => runtime.store.state(runtime.scope), /not open|closed/);
    await runtime.dispose();
});
test("retention cleanup runs while generation and recall are disabled", async (t) => {
    const f = await directory(t),
        sessions = join(f.root, "sessions");
    await mkdir(sessions);
    const ctx = {
        ...fakeContext(f),
        sessionManager: SessionManager.create(f.cwd, sessions),
        mode: "tui",
        hasUI: true,
    };
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    try {
        runtime.store.saveSettings(runtime.scope, {
            ...DEFAULT_SETTINGS,
            generateMemories: false,
            useMemories: false,
            pollIntervalMs: 1000,
        });
        const note = runtime.store.addNote(
            runtime.scope,
            "brief retention fixture",
        );
        runtime.store.setRetention(
            runtime.scope,
            note.path,
            true,
            Date.now() + 500,
        );
        const path = join(runtime.store.artifactRoot(runtime.scope), note.path);
        assert.match(await readFile(path, "utf8"), /brief retention fixture/);
        runtime.start();
        await new Promise((resolve) => setTimeout(resolve, 1250));
        await assert.rejects(readFile(path), { code: "ENOENT" });
    } finally {
        await runtime.dispose();
    }
});
test("fresh CLI help loads without creating memory state or requesting a model", async (t) => {
    const f = await directory(t);
    const binary = fileURLToPath(
        new URL(
            "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
            import.meta.url,
        ),
    );
    const child = spawnSync(
        process.execPath,
        [
            binary,
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "-e",
            packageDir,
            "--help",
        ],
        {
            cwd: f.cwd,
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: f.agentDir,
                PI_OFFLINE: "1",
            },
            encoding: "utf8",
            timeout: 30000,
        },
    );
    assert.equal(child.status, 0, child.stderr);
    await assert.rejects(
        readFile(join(f.agentDir, "pi-codex-memory", "state.sqlite")),
        { code: "ENOENT" },
    );
});
