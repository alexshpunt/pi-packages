import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SettingsManager, SessionManager, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { createGuardExtension } from "../../dist/index.js";
import { powershellIdentity, shellIdentity } from "../../dist/pi-host.js";
import { fixture } from "../harness/fixtures.mjs";
import { FAKE_MODEL, offlineModelRuntime, planStream } from "../harness/pi.mjs";

async function registered(t, options = {}, settings = {}) {
    const f = await fixture(t);
    const tools = new Map(), handlers = new Map(), commands = new Map();
    const extension = createGuardExtension({ cwd: f.workspace, agentDir: f.agentDir, profile: f.profile, mcp: false, ...options });
    const context = { cwd: f.workspace, sessionManager: SessionManager.inMemory(f.workspace), hasUI: false };
    let canReadSettings = false;
    await extension.factory({
        registerTool: (tool) => tools.set(tool.name, tool),
        registerCommand: (name, command) => commands.set(name, command),
        on: (event, handler) => handlers.set(event, handler),
        appendEntry: () => {},
        getSettings: () => {
            expect(canReadSettings, "settings must not be read during the factory").toBe(true);
            return settings;
        },
    });
    canReadSettings = true;
    t.onTestFinished(() => extension.close());
    return { ...f, extension, tools, handlers, commands, context };
}

test("[index] registers without SQLite or rule evaluation, shares initialization and blocks failed first use", async (t) => {
    const f = await registered(t);
    const database = join(f.agentDir, "pi-codex-auto-review.sqlite");
    await expect(access(database)).rejects.toThrow();
    expect(f.tools.size).toBe(8);
    expect(f.tools.get("bash").parameters.properties.additional_permissions).toBeDefined();
    expect(f.tools.get("powershell")).toMatchObject({ defaultActive: false, parameters: { properties: { sandbox_permissions: expect.any(Object) } } });
    const first = f.extension.initialize();
    expect(f.extension.initialize()).toBe(first);
    await first;
    await access(database);
    await f.handlers.get("session_start")({}, f.context);
    expect(f.extension.assertReady().isBoundToSession(f.context.sessionManager.getSessionId())).toBe(true);

    const broken = await registered(t, { settings: { ruleFiles: ["missing.rules"] } });
    await expect(access(join(broken.agentDir, "pi-codex-auto-review.sqlite"))).rejects.toThrow();
    const failed = broken.extension.initialize();
    await expect(failed).rejects.toThrow();
    // A partially initialized guard remains failed until an explicit reload.
    expect(broken.extension.initialize()).toBe(failed);
    await expect(broken.tools.get("write").execute("blocked", { path: "blocked.txt", content: "no" }, undefined, undefined, broken.context)).rejects.toThrow();
    await expect(broken.handlers.get("tool_call")({ toolName: "powershell" }, broken.context)).rejects.toThrow();
    await expect(access(join(broken.workspace, "blocked.txt"))).rejects.toThrow();
});

test("[index] guards opt-in PowerShell like bash; Full Access skips policy and Off uses Pi's own tool", async (t) => {
    const jobs = [];
    const f = await registered(t, {
        executor: { execute: async (job) => { jobs.push(job); return { exitCode: 0 }; }, close: async () => {} },
    });
    await f.handlers.get("session_start")({}, f.context);
    const event = { toolName: "powershell", toolCallId: "powershell", input: { command: "Get-Content notes.txt" } };
    expect(await f.handlers.get("tool_call")(event, f.context)).toBeUndefined();
    const run = (id, command) => f.tools.get("powershell").execute(id, { command }, undefined, undefined, f.context);
    await run("powershell", "Get-Content notes.txt");
    expect(jobs).toEqual([{ kind: "shell", shell: "powershell", command: "Get-Content notes.txt", shellPath: undefined, cwd: f.workspace }]);
    const prepared = f.extension.assertReady().reviewContext.snapshot(60000).items.filter((item) => item.content?.stage === "prepared");
    expect(prepared.at(-1).content).toMatchObject({ tool: "powershell", args: { command: "Get-Content notes.txt", shellPath: await powershellIdentity() } });
    await expect(run("protected", `Set-Content -LiteralPath '${join(f.control, "protected.txt")}' -Value changed`)).rejects.toThrow("Command writes a protected path");
    expect(jobs).toHaveLength(1);
    const guard = f.extension.assertReady();
    guard.setFullAccess(true);
    await run("full-access", `Set-Content -LiteralPath '${join(f.control, "protected.txt")}' -Value changed`);
    expect(jobs).toHaveLength(2);
    guard.setFullAccess(false);
    await guard.updateSettings((current) => ({ ...current, isEnabled: false }), f.workspace, async () => {});
    // Off delegates to Pi's own PowerShell tool, which exists only on Windows.
    await writeFile(join(f.workspace, "notes.txt"), "notes");
    const off = run("off", "Get-Content notes.txt");
    if (process.platform === "win32") expect((await off).content[0].text).toContain("notes");
    else await expect(off).rejects.toThrow("only available on Windows");
    expect(jobs).toHaveLength(2);
});

for (const isEnabled of [true, false]) {
    test(`[index] ordinary delegates preserve effective shell/image settings and SDK overrides (enabled=${isEnabled})`, async (t) => {
        const settings = { shellCommandPrefix: "printf host-prefix", shellPath: process.execPath, images: { autoResize: false } };
        const f = await registered(t, { settings: { isEnabled }, bashOptions: { commandPrefix: "printf sdk-prefix", shellPath: undefined }, readOptions: { resizeOptions: { maxWidth: 1, maxHeight: 1 } } }, settings);
        await f.handlers.get("session_start")({}, f.context);
        const bash = await f.tools.get("bash").execute("sdk-bash", { command: "printf body" }, undefined, undefined, f.context);
        expect(bash.content[0].text).toBe("sdk-prefixbody");
        const originalImage = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";
        await writeFile(join(f.workspace, "image.png"), Buffer.from(originalImage, "base64"));
        const image = await f.tools.get("read").execute("host-image", { path: "image.png" }, undefined, undefined, f.context);
        expect(image.content.find((item) => item.type === "image").data).toBe(originalImage);
        settings.images.autoResize = true;
        const resized = await f.tools.get("read").execute("updated-image", { path: "image.png" }, undefined, undefined, f.context);
        const native = await createReadToolDefinition(f.workspace, { autoResizeImages: true, resizeOptions: { maxWidth: 1, maxHeight: 1 } }).execute("native", { path: "image.png" }, undefined, undefined, f.context);
        expect(resized).toEqual(native);
        expect(resized.content.find((item) => item.type === "image").data).not.toBe(originalImage);
        const override = await registered(t, { settings: { isEnabled }, readOptions: { autoResizeImages: false } }, settings);
        await writeFile(join(override.workspace, "image.png"), Buffer.from(originalImage, "base64"));
        await override.handlers.get("session_start")({}, override.context);
        const overridden = await override.tools.get("read").execute("sdk-image", { path: "image.png" }, undefined, undefined, override.context);
        expect(overridden.content.find((item) => item.type === "image").data).toBe(originalImage);
    });
}

test("[index] ordinary shell settings reach execution and unset shell stays unset while evidence uses Pi identity", async (t) => {
    const jobs = [], settings = { shellCommandPrefix: "printf host-prefix", shellPath: "/configured/shell" };
    const f = await registered(t, {
        executor: { execute: async (job) => { jobs.push(job); return { exitCode: 0 }; }, close: async () => {} },
    }, settings);
    await f.handlers.get("session_start")({}, f.context);
    const run = (id) => f.tools.get("bash").execute(id, { command: "printf body" }, undefined, undefined, f.context);
    await run("configured");
    expect(jobs[0]).toMatchObject({ shellPath: "/configured/shell", command: "printf host-prefix\nprintf body" });
    settings.shellPath = undefined;
    await run("default");
    expect(jobs[1].shellPath).toBeUndefined();
    const actions = f.extension.assertReady().reviewContext.snapshot(60000).items.filter((item) => item.source === "tool-call" && item.content.stage === "prepared");
    expect(JSON.stringify(actions)).toContain(await shellIdentity());
});

for (const isEnabled of [true, false]) {
    test(`[index] ordinary SDK loading reads the real effective Pi settings API (enabled=${isEnabled})`, async (t) => {
        const f = await fixture(t);
        const extension = createGuardExtension({ cwd: f.workspace, agentDir: f.agentDir, mcp: false, settings: { isEnabled } });
        const modelRuntime = await offlineModelRuntime(f);
        const runtime = await createAgentSessionRuntime(async (input) => {
            const services = await createAgentSessionServices({
                ...input, modelRuntime,
                settingsManager: SettingsManager.inMemory({ shellCommandPrefix: "printf effective-prefix", cacheWarming: "off", compaction: { enabled: false } }),
                resourceLoaderOptions: { extensionFactories: [extension.factory], noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true },
            });
            const result = await createAgentSessionFromServices({ services, sessionManager: input.sessionManager, model: FAKE_MODEL });
            await result.session.bindExtensions({ mode: "print" });
            return { ...result, services };
        }, { cwd: f.workspace, agentDir: f.agentDir, sessionManager: SessionManager.inMemory(f.workspace) });
        t.onTestFinished(() => runtime.dispose());
        const events = [];
        runtime.session.subscribe((event) => events.push(event));
        await planStream(runtime.session, [[{ name: "bash", args: { command: "printf body" } }]]);
        await runtime.session.prompt("Run the local fixture.");
        const result = events.find((event) => event.type === "tool_execution_end");
        expect(result.isError).toBe(false);
        expect(result.result.content[0].text).toBe("effective-prefixbody");
    });
}

test("[index] an unspecified shell stays unset for both tool and user-bash execution", async (t) => {
    const jobs = [];
    const f = await registered(t, {
        executor: { execute: async (job) => { jobs.push(job); return { exitCode: 0 }; }, close: async () => {} },
    });
    await f.handlers.get("session_start")({}, f.context);
    await f.tools.get("bash").execute("unset", { command: "printf body" }, undefined, undefined, f.context);
    const user = await f.handlers.get("user_bash")({ command: "printf body" }, f.context);
    await user.operations.exec("printf body", f.workspace, { onData: () => {} });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.shellPath === undefined)).toBe(true);
    const actions = f.extension.assertReady().reviewContext.snapshot(60000).items.filter((item) => item.content?.stage === "prepared");
    expect(actions).toHaveLength(2);
    for (const item of actions) expect(item.content.args.shellPath).toBe(await shellIdentity());
});
