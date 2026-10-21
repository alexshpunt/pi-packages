import { access, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { createGuardExtension } from "../../dist/index.js";
import { fixture } from "../harness/fixtures.mjs";
import { FAKE_MODEL, guardedFixture, planStream } from "../harness/pi.mjs";

const main = {
    id: "main",
    name: "Main model",
    provider: "fixture",
    api: "test",
    maxTokens: 2048,
};
const auxiliary = { ...main, id: "auxiliary", name: "Auxiliary model" };
const approvalDescriptions = {
    "Approve for me": "Only ask for actions detected as potentially unsafe",
    "Ask for approval":
        "Always ask to edit external files and use the internet",
};
const modeChoice = (choices, mode) =>
    choices.find((choice) => choice.startsWith(`${mode} — `));
async function setup(t, options = {}) {
    const f = await fixture(t),
        commands = new Map(),
        tools = new Map(),
        requests = [],
        notifications = [];
    const extension = createGuardExtension({
        mcp: false,
        cwd: f.workspace,
        agentDir: f.agentDir,
        profile: f.profile,
        ...options,
    });
    const api = {
        registerCommand: (name, command) => commands.set(name, command),
        registerTool: (tool) => tools.set(tool.name, tool),
        on: () => {},
        appendEntry: () => {},
    };
    await extension.factory(api);
    t.onTestFinished(() => extension.assertReady().close());
    const sessionManager = SessionManager.inMemory(f.workspace);
    const context = {
        cwd: f.workspace,
        sessionManager,
        model: main,
        scopedModels: [],
        mode: "rpc",
        hasUI: true,
        waitForIdle: async () => {},
        modelRegistry: {
            getAvailable: () => [main, auxiliary],
            find: (provider, id) =>
                [main, auxiliary].find(
                    (model) => model.provider === provider && model.id === id,
                ),
            streamSimple: (selected, _request, options) => {
                requests.push({ selected, options });
                return {
                    result: async () => ({
                        stopReason: "stop",
                        content: [
                            {
                                type: "text",
                                text: '{"outcome":"allow","risk_level":"low","user_authorization":"high"}',
                            },
                        ],
                    }),
                };
            },
        },
        ui: {
            select: async () => undefined,
            notify: (...args) => notifications.push(args),
            setStatus: () => {},
        },
    };
    extension
        .assertReady()
        .reset(sessionManager.getSessionId(), sessionManager);
    extension
        .assertReady()
        .authorizeUser("Modify only the owned outside sentinel.");
    return {
        ...f,
        commands,
        tools,
        requests,
        notifications,
        extension,
        api,
        context,
        settingsPath: join(f.agentDir, "guard/settings.json"),
    };
}
test("[approval-settings] approve configures user or model review and the selected route reaches the original write tool", async (t) => {
    const f = await setup(t),
        target = join(f.outside, "sentinel.txt");
    expect([...f.commands.keys()]).toStrictEqual(["approve", "approve-model"]);
    f.context.ui.select = async (title, choices) =>
        title.startsWith("Approval mode")
            ? modeChoice(choices, "Ask for approval")
            : choices[0];
    await f.commands.get("approve").handler("", f.context);
    expect(f.extension.assertReady().options.settings.approvalsReviewer).toBe(
        "user",
    );
    expect(
        JSON.parse(await readFile(f.settingsPath, "utf8")).approvalsReviewer,
    ).toBe("user");
    expect((await stat(f.settingsPath)).mode & 0o777).toBe(0o600);
    await f.tools
        .get("write")
        .execute(
            "user-write",
            { path: target, content: "user-approved" },
            undefined,
            undefined,
            f.context,
        );
    expect(await readFile(target, "utf8")).toBe("user-approved");
    expect(f.requests.length).toBe(0);
    f.context.ui.select = async (_title, choices) =>
        modeChoice(choices, "Approve for me");
    await f.commands.get("approve").handler("", f.context);
    await f.tools
        .get("write")
        .execute(
            "model-write",
            { path: target, content: "model-approved" },
            undefined,
            undefined,
            f.context,
        );
    expect(await readFile(target, "utf8")).toBe("model-approved");
    expect(f.requests.length).toBe(1);
});
test("[approval-settings] the searchable picker selects only the auxiliary reviewer and follows the main model when cleared", async (t) => {
    const f = await setup(t),
        target = join(f.outside, "sentinel.txt");
    initTheme("dark", false);
    f.context.mode = "tui";
    f.context.ui.custom = (factory) =>
        new Promise((resolve) => {
            const picker = factory(undefined, undefined, undefined, resolve);
            expect(
                picker.render(90).join("\n").includes("Auxiliary model"),
            ).toBeTruthy();
            for (const character of "Auxiliary") picker.handleInput(character);
            picker.handleInput("\r");
        });
    await f.commands.get("approve-model").handler("", f.context);
    expect(
        f.extension.assertReady().options.settings.reviewModel,
    ).toStrictEqual({
        provider: "fixture",
        id: "auxiliary",
    });
    expect(f.context.model).toBe(main);
    await f.tools
        .get("write")
        .execute(
            "auxiliary-write",
            { path: target, content: "auxiliary-reviewed" },
            undefined,
            undefined,
            f.context,
        );
    expect(f.requests.at(-1).selected).toBe(auxiliary);
    expect(await readFile(target, "utf8")).toBe("auxiliary-reviewed");
    f.context.mode = "rpc";
    f.context.ui.select = async (_title, choices) => choices[0];
    await f.commands.get("approve-model").handler("", f.context);
    expect(f.extension.assertReady().options.settings.reviewModel).toBe(null);
    await f.tools
        .get("write")
        .execute(
            "current-write",
            { path: target, content: "main-reviewed" },
            undefined,
            undefined,
            f.context,
        );
    expect(f.requests.at(-1).selected).toBe(main);
    expect(await readFile(target, "utf8")).toBe("main-reviewed");
});
test("[approval-settings] Escape and unavailable UI preserve settings without saving or executing anything", async (t) => {
    const f = await setup(t);
    await f.commands.get("approve").handler("", f.context);
    f.context.mode = "tui";
    f.context.ui.custom = (factory) =>
        new Promise((resolve) =>
            factory(undefined, undefined, undefined, resolve).handleInput(
                "\x1b",
            ),
        );
    await f.commands.get("approve-model").handler("", f.context);
    await expect(access(f.settingsPath)).rejects.toThrow();
    expect(f.requests.length).toBe(0);
    const withoutUI = { ...f.context, hasUI: false };
    await expect(
        f.commands.get("approve").handler("", withoutUI),
    ).rejects.toThrow(
        expect.toSatisfy((error) => error.code === "APPROVAL_UI_UNAVAILABLE"),
    );
    await expect(
        f.commands.get("approve-model").handler("", withoutUI),
    ).rejects.toThrow(
        expect.toSatisfy((error) => error.code === "APPROVAL_UI_UNAVAILABLE"),
    );
});
test("[approval-settings] reload restores both selections and the persisted model remains selected in the picker", async (t) => {
    const f = await setup(t);
    f.context.ui.select = async (title, choices) =>
        title.startsWith("Approval mode")
            ? modeChoice(choices, "Ask for approval")
            : choices.at(-1);
    await f.commands.get("approve").handler("", f.context);
    await f.commands.get("approve-model").handler("", f.context);
    const before = await readFile(f.settingsPath, "utf8");
    await f.extension.factory(f.api);
    expect(f.extension.assertReady().options.settings.approvalsReviewer).toBe(
        "user",
    );
    expect(
        f.extension.assertReady().options.settings.reviewModel,
    ).toStrictEqual({
        id: "auxiliary",
        provider: "fixture",
    });
    f.context.mode = "tui";
    f.context.ui.custom = (factory) =>
        new Promise((resolve) =>
            factory(undefined, undefined, undefined, resolve).handleInput("\r"),
        );
    await f.commands.get("approve-model").handler("", f.context);
    expect(await readFile(f.settingsPath, "utf8")).toBe(before);
});
test("[approval-settings] concurrent choices preserve each other and a failed save leaves the runtime unchanged", async (t) => {
    const f = await setup(t);
    f.context.ui.select = async (title, choices) =>
        title.startsWith("Approval mode")
            ? modeChoice(choices, "Ask for approval")
            : choices.at(-1);
    await Promise.all([
        f.commands.get("approve").handler("", f.context),
        f.commands.get("approve-model").handler("", f.context),
    ]);
    const saved = JSON.parse(await readFile(f.settingsPath, "utf8"));
    expect(saved.approvalsReviewer).toBe("user");
    expect(saved.reviewModel).toStrictEqual({
        id: "auxiliary",
        provider: "fixture",
    });
    const broken = await setup(t);
    await mkdir(broken.settingsPath, { recursive: true });
    broken.context.ui.select = async (_title, choices) =>
        modeChoice(choices, "Ask for approval");
    await expect(
        broken.commands.get("approve").handler("", broken.context),
    ).rejects.toThrow();
    expect(
        broken.extension.assertReady().options.settings.approvalsReviewer,
    ).toBe("auto_review");
});
test("[approval-settings] settings changes cancel a pending old-model approval before its late allow can write", async (t) => {
    let started, finish;
    const waiting = new Promise((resolve) => (started = resolve));
    const f = await setup(t, {
        provider: {
            complete: () => {
                started();
                return new Promise((resolve) => (finish = resolve));
            },
        },
    });
    const target = join(f.outside, "sentinel.txt");
    const pending = f.tools
        .get("write")
        .execute(
            "old-review",
            { path: target, content: "must not happen" },
            undefined,
            undefined,
            f.context,
        );
    const rejected = expect(pending).rejects.toThrow();
    await waiting;
    f.context.ui.select = async (_title, choices) =>
        modeChoice(choices, "Ask for approval");
    await f.commands.get("approve").handler("", f.context);
    finish('{"outcome":"allow"}');
    await rejected;
    expect(await readFile(target, "utf8")).toBe("unchanged");
});
test("[approval-settings] the actual mode picker renders Codex descriptions and all command UI in English", async (t) => {
    const f = await setup(t);
    initTheme("dark", false);
    f.context.mode = "tui";
    f.context.ui.select = async (title, choices) => {
        for (const description of Object.values(approvalDescriptions))
            expect(
                [title, ...choices].join("\n").includes(description),
            ).toBeTruthy();
        return modeChoice(choices, "Ask for approval");
    };
    f.context.ui.custom = (factory) =>
        new Promise((resolve) => {
            const picker = factory(undefined, undefined, undefined, resolve);
            const screen = stripVTControlCharacters(
                picker.render(120).join("\n"),
            );
            for (const description of Object.values(approvalDescriptions))
                expect(screen.includes(description), screen).toBeTruthy();
            expect(screen).not.toMatch(/[가-힣]/);
            picker.handleInput("\x1b[B");
            picker.handleInput("\r");
        });
    await f.commands.get("approve").handler("", f.context);
    expect(f.extension.assertReady().options.settings.approvalsReviewer).toBe(
        "user",
    );
    expect(
        [...f.commands.values()]
            .map((command) => command.description)
            .join("\n"),
    ).not.toMatch(/[가-힣]/);
    expect(f.notifications.map(([text]) => text).join("\n")).not.toMatch(
        /[가-힣]/,
    );
    f.context.ui.custom = (factory) =>
        new Promise((resolve) => {
            const picker = factory(undefined, undefined, undefined, resolve);
            const screen = stripVTControlCharacters(
                picker.render(36).join(" "),
            ).replace(/\s+/g, " ");
            expect(
                screen.includes(approvalDescriptions["Ask for approval"]),
                screen,
            ).toBeTruthy();
            picker.handleInput("\x1b");
        });
    await f.commands.get("approve").handler("", f.context);
    expect(f.extension.assertReady().options.settings.approvalsReviewer).toBe(
        "user",
    );
});
test("[approval-settings] both model pickers honor the live scope and reject a selection removed while open", async (t) => {
    const f = await setup(t),
        screens = [];
    f.context.scopedModels = [
        { model: auxiliary },
        { model: { ...main, id: "unavailable" } },
        { model: auxiliary },
    ];
    f.context.ui.select = async (title, choices) => {
        screens.push({ title, choices });
        expect(choices.length).toBe(2);
        expect(choices[0].startsWith("Use current Pi model")).toBeTruthy();
        expect(choices[1].includes("fixture/auxiliary")).toBeTruthy();
        return choices[1];
    };
    await f.commands.get("approve-model").handler("", f.context);
    const before = await readFile(f.settingsPath, "utf8");
    initTheme("dark", false);
    f.context.mode = "tui";
    f.context.ui.custom = (factory) =>
        new Promise((resolve) => {
            const picker = factory(undefined, undefined, undefined, resolve);
            const screen = stripVTControlCharacters(
                picker.render(100).join("\n"),
            );
            expect(screen.includes("Auxiliary model")).toBeTruthy();
            expect(screen.includes("Main model")).toBeFalsy();
            expect(screen).not.toMatch(/[가-힣]/);
            f.context.scopedModels = [{ model: main }];
            picker.handleInput("\r");
        });
    await expect(
        f.commands.get("approve-model").handler("", f.context),
    ).rejects.toThrow(
        expect.toSatisfy((error) => error.code === "MODEL_UNAVAILABLE"),
    );
    expect(await readFile(f.settingsPath, "utf8")).toBe(before);
    f.context.mode = "rpc";
    f.context.scopedModels = [{ model: { ...main, id: "unavailable" } }];
    f.context.ui.select = async (_title, choices) => {
        expect(choices.length).toBe(1);
        return undefined;
    };
    await f.commands.get("approve-model").handler("", f.context);
    f.context.scopedModels = [];
    f.context.ui.select = async (_title, choices) => {
        expect(choices.length).toBe(3);
        return undefined;
    };
    await f.commands.get("approve-model").handler("", f.context);
    expect(await readFile(f.settingsPath, "utf8")).toBe(before);
    expect(JSON.stringify(screens)).not.toMatch(/[가-힣]/);
});
test("[approval-settings] Pi session scope selection reaches the auxiliary reviewer and preserves allow and deny effects", async (t) => {
    const f = await fixture(t),
        requests = [],
        choicesSeen = [];
    const runtime = await guardedFixture(t, f, { provider: undefined });
    const auxiliaryModel = {
        ...FAKE_MODEL,
        id: "scoped-reviewer",
        name: "Scoped reviewer",
    };
    const excludedModel = {
        ...FAKE_MODEL,
        id: "excluded",
        name: "Excluded model",
    };
    runtime.services.modelRuntime.registerProvider("fixture", {
        baseUrl: "http://unused.invalid",
        api: "openai-completions",
        apiKey: "fixture",
        models: [FAKE_MODEL, auxiliaryModel, excludedModel],
    });
    let shouldAllow = true;
    runtime.services.modelRuntime.streamSimple = (model, request, options) => {
        requests.push({ model, request, options });
        return {
            result: async () => ({
                stopReason: "stop",
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            outcome: shouldAllow ? "allow" : "deny",
                            risk_level: "low",
                            user_authorization: "high",
                            rationale: "Owned scoped-model fixture",
                        }),
                    },
                ],
            }),
        };
    };
    runtime.session.setScopedModels([{ model: auxiliaryModel }]);
    await runtime.session.bindExtensions({
        mode: "rpc",
        uiContext: {
            select: async (title, choices) => {
                choicesSeen.push({ title, choices });
                return choices.find((choice) =>
                    choice.includes("fixture/scoped-reviewer"),
                );
            },
            notify() {},
            setStatus() {},
            setWidget() {},
        },
    });
    await runtime.session.prompt("/approve-model");
    expect(choicesSeen.length).toBe(1);
    expect(choicesSeen[0].choices.length).toBe(2);
    expect(
        choicesSeen[0].choices.some((choice) =>
            choice.includes("Excluded model"),
        ),
    ).toBeFalsy();
    const target = join(f.outside, "sentinel.txt");
    await planStream(runtime.session, [
        [{ name: "write", args: { path: target, content: "approved" } }],
    ]);
    await runtime.session.prompt("Write only the owned outside sentinel.");
    expect(await readFile(target, "utf8")).toBe("approved");
    shouldAllow = false;
    await planStream(runtime.session, [
        [{ name: "write", args: { path: target, content: "denied" } }],
    ]);
    await runtime.session.prompt(
        "Repeat the owned fixture with the denial control.",
    );
    expect(await readFile(target, "utf8")).toBe("approved");
    expect(requests.length).toBe(2);
    expect(
        requests.every((item) => item.model.id === "scoped-reviewer"),
    ).toBeTruthy();
    expect(runtime.session.model.id).toBe(FAKE_MODEL.id);
});
test("[approval-settings] approve retry reconnects the exact denial to fresh review without a reusable grant", async (t) => {
    const requests = [],
        sent = [];
    const f = await setup(t, {
        provider: {
            complete: async (request) => {
                const data = JSON.parse(request.data);
                requests.push(data);
                const hasRetry = data.context.items.some(
                    (item) =>
                        item.content?.type === "exact-action-retry-approval",
                );
                return JSON.stringify({
                    outcome: hasRetry ? "allow" : "deny",
                    risk_level: "high",
                    user_authorization: hasRetry ? "high" : "low",
                    rationale:
                        "The exact overwrite needs explicit confirmation.",
                });
            },
        },
    });
    f.api.sendUserMessage = (text, options) => sent.push({ text, options });
    const tool = f.tools.get("write"),
        args = {
            path: join(f.outside, "sentinel.txt"),
            content: "confirmed once",
        };
    await expect(
        tool.execute("initial", args, undefined, undefined, f.context),
    ).rejects.toThrow(
        expect.toSatisfy((error) => error.code === "AUTO_REVIEW_DENIED"),
    );
    f.context.ui.select = async (title, choices) => {
        expect(title).toMatch(/denied action/);
        expect(choices[0]).toMatch(/exact overwrite/);
        return choices[0];
    };
    await f.commands.get("approve").handler("retry", f.context);
    expect(sent.length).toBe(1);
    expect(
        sent[0].text.includes(JSON.stringify(args).slice(1, -1).split(",")[0]),
    ).toBeTruthy();
    expect(sent[0].options.expandPromptTemplates).toBe(false);
    expect(f.extension.assertReady().options.settings.approvalsReviewer).toBe(
        "auto_review",
    );
    await tool.execute("retry", args, undefined, undefined, f.context);
    expect(await readFile(args.path, "utf8")).toBe("confirmed once");
    await expect(
        tool.execute("consumed", args, undefined, undefined, f.context),
    ).rejects.toThrow(
        expect.toSatisfy((error) => error.code === "AUTO_REVIEW_DENIED"),
    );
    expect(requests.length).toBe(3);
    expect(
        requests.filter((request) =>
            request.context.items.some(
                (item) => item.content?.type === "exact-action-retry-approval",
            ),
        ).length,
    ).toBe(1);
});
test("[approval-settings] the actual Pi retry command preserves its one-use marker through extension-generated input", async (t) => {
    const f = await fixture(t),
        requests = [],
        target = join(f.outside, "sentinel.txt");
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async (request) => {
                const data = JSON.parse(request.data);
                requests.push(data);
                const hasRetry = data.context.items.some(
                    (item) =>
                        item.content?.type === "exact-action-retry-approval",
                );
                return JSON.stringify({
                    outcome: hasRetry ? "allow" : "deny",
                    risk_level: "high",
                    user_authorization: hasRetry ? "high" : "low",
                    rationale: "Confirm this exact overwrite.",
                });
            },
        },
    });
    await runtime.session.bindExtensions({
        mode: "rpc",
        uiContext: {
            select: async (title, choices) => {
                expect(title).toMatch(/denied action/);
                return choices[0];
            },
            notify() {},
            setStatus() {},
            setWidget() {},
        },
    });
    const step = [
        [
            {
                name: "write",
                args: { path: target, content: "retried through Pi" },
            },
        ],
    ];
    await planStream(runtime.session, step);
    await runtime.session.prompt("Perform the named overwrite if approved.");
    expect(await readFile(target, "utf8")).toBe("unchanged");
    let finish;
    const settled = new Promise((resolve) => (finish = resolve));
    const unsubscribe = runtime.session.subscribe((event) => {
        if (event.type === "agent_end") finish();
    });
    const timeout = setTimeout(() => finish(), 10000);
    try {
        await planStream(runtime.session, step);
        await runtime.session.prompt("/approve retry");
        await settled;
    } finally {
        clearTimeout(timeout);
        unsubscribe();
    }
    expect(await readFile(target, "utf8")).toBe("retried through Pi");
    expect(requests.length).toBe(2);
    expect(
        requests[1].context.items.some(
            (item) => item.content?.type === "exact-action-retry-approval",
        ),
    ).toBeTruthy();
    expect(
        requests[1].context.items.some(
            (item) =>
                item.source === "user" &&
                String(item.content).includes("controller holds a one-use"),
        ),
    ).toBeFalsy();
});
test("[approval-settings] a past critical denial can be reassessed but a fresh critical assessment still prevents execution", async (t) => {
    let hasCorrectedRisk = true;
    const requests = [],
        f = await setup(t, {
            provider: {
                complete: async (request) => {
                    const data = JSON.parse(request.data),
                        hasRetry = data.context.items.some(
                            (item) =>
                                item.content?.type ===
                                "exact-action-retry-approval",
                        );
                    requests.push(data);
                    return JSON.stringify({
                        outcome: hasRetry ? "allow" : "deny",
                        risk_level:
                            hasRetry && hasCorrectedRisk ? "high" : "critical",
                        user_authorization: hasRetry ? "high" : "unknown",
                        rationale:
                            "Reassess the exact target using the new authorization.",
                    });
                },
            },
        });
    f.api.sendUserMessage = () => {};
    f.context.ui.select = async (_title, choices) => choices[0];
    const tool = f.tools.get("write"),
        args = {
            path: join(f.outside, "sentinel.txt"),
            content: "approved after reassessment",
        };
    await expect(
        tool.execute("initial-critical", args, undefined, undefined, f.context),
    ).rejects.toThrow(
        expect.toSatisfy((error) => error.code === "AUTO_REVIEW_DENIED"),
    );
    expect(
        f.extension.assertReady().approvals.lifecycle.recentDenials[0]
            .assessment.risk_level,
    ).toBe("critical");
    await f.commands.get("approve").handler("retry", f.context);
    await tool.execute("risk-corrected", args, undefined, undefined, f.context);
    expect(await readFile(args.path, "utf8")).toBe(
        "approved after reassessment",
    );
    hasCorrectedRisk = false;
    const next = { ...args, content: "must remain blocked" };
    await expect(
        tool.execute("another-critical", next, undefined, undefined, f.context),
    ).rejects.toThrow(
        expect.toSatisfy((error) => error.code === "AUTO_REVIEW_DENIED"),
    );
    await f.commands.get("approve").handler("retry", f.context);
    await expect(
        tool.execute("still-critical", next, undefined, undefined, f.context),
    ).rejects.toThrow(
        expect.toSatisfy((error) => error.code === "AUTO_REVIEW_DENIED"),
    );
    expect(await readFile(args.path, "utf8")).toBe(
        "approved after reassessment",
    );
    expect(requests.length).toBe(4);
});
test("[approval-settings] a genuine later user prompt authorizes fresh Pi review after a critical denial without a retry command", async (t) => {
    const f = await fixture(t),
        requests = [],
        target = join(f.outside, "sentinel.txt");
    const approval = `I saw the warning. It was misclassified: this is one owned local fixture, with no credential access or destructive side effects. I explicitly approve writing exactly confirmed-by-user to ${target}.`;
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async (request) => {
                const data = JSON.parse(request.data);
                requests.push(data);
                const confirmed = data.context.items.findIndex(
                    (item) =>
                        item.source === "user" &&
                        item.trust === "authorization" &&
                        item.content === approval,
                );
                if (confirmed >= 0) {
                    expect(
                        data.context.items
                            .slice(0, confirmed)
                            .some(
                                (item) =>
                                    item.trust === "evidence" &&
                                    JSON.stringify(item.content).includes(
                                        "AUTO_REVIEW_DENIED",
                                    ),
                            ),
                    ).toBeTruthy();
                    expect(
                        data.context.items.some(
                            (item) =>
                                item.content?.type ===
                                "exact-action-retry-approval",
                        ),
                    ).toBeFalsy();
                }
                return JSON.stringify({
                    outcome: confirmed >= 0 ? "allow" : "deny",
                    risk_level: confirmed >= 0 ? "high" : "critical",
                    user_authorization: confirmed >= 0 ? "high" : "unknown",
                    rationale:
                        confirmed >= 0
                            ? "New facts and exact user approval resolve the prior concern."
                            : "Concrete risk was not authorized.",
                });
            },
        },
    });
    const step = [
        [
            {
                name: "write",
                args: { path: target, content: "confirmed-by-user" },
            },
        ],
    ];
    await planStream(runtime.session, step);
    await runtime.session.prompt(
        "Inspect the task. Do not overwrite the outside file.",
    );
    expect(await readFile(target, "utf8")).toBe("unchanged");
    await planStream(runtime.session, step);
    await runtime.session.prompt(approval);
    expect(await readFile(target, "utf8")).toBe("confirmed-by-user");
    expect(requests.length).toBe(2);
});
