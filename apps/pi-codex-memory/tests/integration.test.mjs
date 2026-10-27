import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
    initTheme,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { memoryCommand } from "../dist/commands.js";
import { DEFAULT_SETTINGS } from "../dist/config.js";
import extension from "../dist/index.js";
import { EMPTY_SUMMARY } from "../dist/pipeline.js";
import { MemoryRuntime } from "../dist/runtime.js";
import { workspaceScope } from "../dist/safety.js";
import { settingsCommand } from "../dist/settings-commands.js";
import { MemoryStore } from "../dist/store.js";
import { pickRow, terminalPicker } from "./ui.mjs";

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
test("two argument-free memory commands are registered; tools validate disabled access, consent and abort", async (t) => {
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
        ["codex-memory", "codex-memory-settings"],
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
    await assert.rejects(
        tools
            .get("pi_codex_memory_list")
            .execute("list", {}, undefined, undefined, ctx),
        /Memory is disabled/,
        "memory is off until the user turns it on",
    );
    const configured = new MemoryStore(join(f.agentDir, "pi-codex-memory"));
    configured.saveSettings(workspaceScope(f.cwd), {
        ...DEFAULT_SETTINGS,
        useMemories: true,
        generateMemories: true,
        extractModel: { provider: "fixture", id: "local" },
        consolidateModel: { provider: "fixture", id: "local" },
    });
    configured.close();
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
    await commands.get("codex-memory-settings").handler("", ctx);
    assert.deepEqual(notices, ["A memory menu is already open."]);
    assert.equal(closeMenu, firstClose, "a second menu does not open");
    closeMenu(undefined);
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
        useMemories: true,
        generateMemories: true,
        extractModel: { provider: "fixture", id: "extract" },
        consolidateModel: { provider: "fixture", id: "consolidate" },
    });
    await handlers.get("session_start")({}, ctx);
    const notices = [],
        statuses = [];
    ctx.ui.notify = (message) => notices.push(message);
    ctx.ui.setStatus = (_key, text) => statuses.push(text);
    ctx.ui.custom = terminalPicker(["Remember this conversation now"]);
    await commands.get("codex-memory-settings").handler("", ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(notices[0], /Remembering this conversation/);
    assert.ok(seen && !seen.aborted);
    const picker = terminalPicker(["Stop current job", undefined]);
    let opened = 0;
    ctx.ui.custom = (factory) => {
        if (opened++ === 0)
            assert.equal(
                seen.aborted,
                false,
                "opening the menu does not cancel",
            );
        return picker(factory);
    };
    await commands.get("codex-memory-settings").handler("", ctx);
    assert.equal(seen.aborted, true);
    assert.ok(notices.includes("Stopped the memory job."));
    assert.equal(messages.length, 0);
    assert.ok(statuses.includes("Memory: on · creating 1 memory…"));
    assert.equal(
        statuses.at(-1),
        "Memory: on",
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
function terminalContext(f, ui) {
    return {
        ...fakeContext(f, { confirm: async () => true, ...ui }),
        mode: "tui",
        hasUI: true,
    };
}
function repositoryContext(runtime) {
    return {
        store: runtime.store,
        scope: runtime.scope,
        cwd: runtime.cwd,
        signal: runtime.signal,
    };
}
function commandOptions(ctx, runtime) {
    return {
        ctx,
        runtime,
        repositories: repositoryContext(runtime),
        show() {},
        changeScope: async () => {},
    };
}
test("turning memory on asks only for consent, follows the current Pi model, and saves nothing when declined", async (t) => {
    const f = await directory(t);
    const screens = [],
        consents = [];
    let isAccepted = false;
    const ctx = terminalContext(f, {
        confirm: async (_title, message) => {
            consents.push(message);
            return isAccepted;
        },
    });
    ctx.model = { provider: "fixture", id: "main" };
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    ctx.ui.custom = terminalPicker(["Enabled", undefined], screens);
    await memoryCommand(commandOptions(ctx, runtime));
    assert.equal(runtime.settings().generateMemories, false);
    assert.equal(runtime.settings().useMemories, false);
    assert.match(screens[0], /Enabled\s+off/);
    assert.match(screens[0], /Memory model\s+Current Pi model/);
    assert.match(screens[0], /Summary model\s+Current Pi model/);
    assert.match(screens[0], /Turns closed conversations into memories/);
    assert.equal(consents.length, 1);
    assert.match(consents[0], /the current Pi model \(now main \[fixture\]\)/);
    isAccepted = true;
    ctx.ui.custom = terminalPicker(["Enabled", undefined], screens);
    await memoryCommand(commandOptions(ctx, runtime));
    assert.equal(runtime.settings().useMemories, true);
    assert.equal(runtime.settings().generateMemories, true);
    assert.equal(runtime.settings().extractModel, null);
    assert.equal(runtime.settings().consolidateModel, null);
    assert.match(screens.at(-1), /Enabled\s+on/);
    ctx.ui.custom = terminalPicker(["Enabled", undefined]);
    await memoryCommand(commandOptions(ctx, runtime));
    assert.equal(runtime.settings().useMemories, false);
    assert.equal(runtime.settings().generateMemories, false);
    await runtime.dispose();
});
test("an option list opened from a focused settings page shows the cursor in its filter", async (t) => {
    const f = await directory(t);
    const ctx = terminalContext(f, {});
    ctx.modelRegistry = {
        getAvailable: () => [{ provider: "fixture", id: "local" }],
    };
    let page;
    ctx.ui.custom = (factory) =>
        new Promise((resolve) => {
            initTheme();
            page = factory(
                { requestRender() {} },
                { fg: (_color, text) => text, bold: (text) => text },
                undefined,
                resolve,
            );
            page.focused = true;
            page.handleInput("\x1b[B");
            page.handleInput("\r");
            assert.ok(
                page.render(120).some((line) => line.includes(CURSOR_MARKER)),
            );
            page.handleInput("\x1b");
            page.handleInput("\x1b");
        });
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    await memoryCommand(commandOptions(ctx, runtime));
    assert.ok(page);
    await runtime.dispose();
});
test("each stage picks its own model from the current Pi model and /scoped-models; a change while on asks for consent again", async (t) => {
    const f = await directory(t);
    const local = { provider: "fixture", id: "local" },
        other = { provider: "fixture", id: "other" };
    const store = new MemoryStore(join(f.agentDir, "pi-codex-memory"));
    store.saveSettings(workspaceScope(f.cwd), {
        ...DEFAULT_SETTINGS,
        useMemories: true,
        generateMemories: true,
    });
    store.close();
    const screens = [];
    let consents = 0,
        isAccepted = false;
    const ctx = terminalContext(f, {
        confirm: async () => {
            consents++;
            return isAccepted;
        },
    });
    ctx.scopedModels = [{ model: local }, { model: other }];
    ctx.modelRegistry = {
        getAvailable: () => [
            local,
            other,
            { provider: "fixture", id: "hidden" },
        ],
    };
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    ctx.ui.custom = terminalPicker(
        [
            "Memory model",
            { search: "other", pick: "other [fixture]" },
            undefined,
        ],
        screens,
    );
    await memoryCommand(commandOptions(ctx, runtime));
    assert.match(
        screens[1],
        /Use current Pi model\s+Follow the model selected/,
    );
    assert.match(screens[1], /local \[fixture\]/);
    assert.match(screens[1], /other \[fixture\]/);
    assert.doesNotMatch(screens[1], /hidden/);
    assert.match(
        screens[1],
        /Type to filter · Enter to select · Esc to go back/,
    );
    assert.equal(consents, 1);
    assert.equal(runtime.settings().extractModel, null, "declined");
    isAccepted = true;
    ctx.ui.custom = terminalPicker(
        [
            "Memory model",
            "other [fixture]",
            "Summary model",
            "local [fixture]",
            undefined,
        ],
        screens,
    );
    await memoryCommand(commandOptions(ctx, runtime));
    assert.equal(consents, 3);
    assert.deepEqual(runtime.settings().extractModel, other);
    assert.deepEqual(runtime.settings().consolidateModel, local);
    assert.match(screens.at(-1), /Memory model\s+other \[fixture\]/);
    assert.match(screens.at(-1), /Summary model\s+local \[fixture\]/);
    ctx.ui.custom = terminalPicker([
        "Memory model",
        "Use current Pi model",
        undefined,
    ]);
    await memoryCommand(commandOptions(ctx, runtime));
    assert.equal(runtime.settings().extractModel, null);
    assert.deepEqual(runtime.settings().consolidateModel, local);
    await runtime.dispose();
});
test("settings cycle preset values in place, keep a stored custom value in the cycle, and work without a terminal", async (t) => {
    const f = await directory(t);
    const screens = [];
    const ctx = terminalContext(f, {});
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    ctx.ui.custom = terminalPicker(
        ["Create memories after", undefined],
        screens,
    );
    await settingsCommand(commandOptions(ctx, runtime));
    assert.equal(runtime.settings().minIdleMs, 6 * 3_600_000);
    assert.match(screens[0], /Create memories after\s+2 hours idle/);
    assert.match(screens[0], /Use conversations from the last\s+7 days/);
    assert.doesNotMatch(
        screens[0],
        /Saved memories/,
        "it lives in /codex-memory",
    );
    assert.match(screens[0], /Type to search · Enter\/Space to change/);
    assert.match(screens[1], /Create memories after\s+6 hours idle/);
    assert.match(screens[1], /a closed conversation becomes memory/);
    assert.match(screens[1], /Default: 2 hours\s+idle\./);
    await runtime.saveSettings({
        ...runtime.settings(),
        minIdleMs: 45 * 60_000,
    });
    ctx.ui.custom = terminalPicker(
        ["Create memories after", undefined],
        screens,
    );
    await settingsCommand(commandOptions(ctx, runtime));
    assert.match(screens.at(-2), /Create memories after\s+45 minutes idle/);
    assert.equal(runtime.settings().minIdleMs, 60 * 60_000);
    const rows = [];
    const plain = fakeContext(f, {
        select: async (_title, options) => {
            rows.push(options);
            return pickRow(options, picks.shift());
        },
    });
    plain.hasUI = true;
    const picks = ["Delete unused memories after", "90 days", undefined];
    await settingsCommand(commandOptions(plain, runtime));
    assert.ok(rows[0].includes("Delete unused memories after: 30 days"));
    assert.deepEqual(rows[1], ["7 days", "30 days", "90 days", "365 days"]);
    assert.equal(runtime.settings().maxUnusedDays, 90);
    await runtime.dispose();
});
test("an in-place change that stops a running job swaps Stop current job for Remember this conversation now", async (t) => {
    const f = await directory(t);
    const ctx = terminalContext(f, {});
    ctx.modelRegistry = {
        getAvailable: () => [],
        find: (provider, id) => ({ provider, id }),
        streamSimple(_model, _context, options) {
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
    };
    ctx.sessionManager.appendMessage({
        role: "user",
        content: "A source that keeps the job running.",
        timestamp: Date.now(),
    });
    const store = new MemoryStore(join(f.agentDir, "pi-codex-memory"));
    store.saveSettings(workspaceScope(f.cwd), {
        ...DEFAULT_SETTINGS,
        useMemories: true,
        generateMemories: true,
        extractModel: { provider: "fixture", id: "extract" },
        consolidateModel: { provider: "fixture", id: "consolidate" },
    });
    store.close();
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    const work = runtime.run("current").catch(() => {});
    assert.equal(runtime.isRunning, true);
    const screens = [];
    ctx.ui.custom = terminalPicker(
        ["Create memories after", undefined],
        screens,
    );
    await settingsCommand(commandOptions(ctx, runtime));
    await work;
    assert.match(screens[0], /Stop current job\s+running/);
    assert.match(screens[1], /→ Create memories after\s+6 hours idle/);
    assert.doesNotMatch(screens[1], /Stop current job/);
    assert.match(screens[1], /Remember this conversation now/);
    await runtime.dispose();
});
test("/codex-memory opens Saved memories; the list returns with its filter after each memory, and Esc goes back to the page", async (t) => {
    const f = await directory(t);
    const screens = [];
    const ctx = terminalContext(f, {
        editor: async () => "Release gate is violet.",
    });
    const clear = "\x7f".repeat(5);
    ctx.ui.custom = terminalPicker(
        [
            "Saved memories",
            { search: "amber", pick: "Release gate" },
            "View memory and source",
            "Release gate",
            "Edit memory",
            { search: `${clear}violet`, pick: "Release gate is violet" },
            "Forget memory",
            undefined,
            undefined,
        ],
        screens,
    );
    const runtime = new MemoryRuntime(ctx, f.agentDir);
    runtime.store.addNote(runtime.scope, "Release gate is amber.");
    runtime.store.addNote(runtime.scope, "Region is birch.");
    await memoryCommand(commandOptions(ctx, runtime));
    const bodies = runtime.store.records(runtime.scope).map((r) => r.body);
    assert.deepEqual(bodies, ["Region is birch."]);
    assert.match(screens[0], /Saved memories\s+2/);
    assert.match(
        screens[1],
        /Type to filter · Enter to select · Esc to go back/,
    );
    assert.match(screens[2], /View memory and source/);
    // After viewing, the list is back with its filter and the memory highlighted.
    assert.match(screens[3], /^> amber\b/m);
    assert.match(screens[3], /→ Release gate is amber/);
    assert.doesNotMatch(screens[3], /Memory scope/);
    // After forgetting, Esc leaves the list for the /codex-memory page.
    assert.match(screens.at(-2), /Type to filter/);
    assert.match(screens.at(-1), /Saved memories\s+1/);
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
    store.saveSettings(workspaceScope(f.cwd), {
        ...DEFAULT_SETTINGS,
        useMemories: true,
    });
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
    await session.prompt("/codex-memory");
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
        useMemories: true,
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
                pickRow(rows, "Remember this conversation now"),
        },
        onError: (error) => errors.push(error),
    });
    await session.prompt("/codex-memory-settings");
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
