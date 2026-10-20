import assert from "node:assert/strict";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
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
    t.after(() => extension.assertReady().close());
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
    assert.deepEqual([...f.commands.keys()], ["approve", "approve-model"]);
    f.context.ui.select = async (title, choices) =>
        title.startsWith("Approval mode")
            ? modeChoice(choices, "Ask for approval")
            : choices[0];
    await f.commands.get("approve").handler("", f.context);
    assert.equal(
        f.extension.assertReady().options.settings.approvalsReviewer,
        "user",
    );
    assert.equal(
        JSON.parse(await readFile(f.settingsPath, "utf8")).approvalsReviewer,
        "user",
    );
    assert.equal((await stat(f.settingsPath)).mode & 0o777, 0o600);
    await f.tools
        .get("write")
        .execute(
            "user-write",
            { path: target, content: "user-approved" },
            undefined,
            undefined,
            f.context,
        );
    assert.equal(await readFile(target, "utf8"), "user-approved");
    assert.equal(f.requests.length, 0);
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
    assert.equal(await readFile(target, "utf8"), "model-approved");
    assert.equal(f.requests.length, 1);
});
test("[approval-settings] the searchable picker selects only the auxiliary reviewer and follows the main model when cleared", async (t) => {
    const f = await setup(t),
        target = join(f.outside, "sentinel.txt");
    initTheme("dark", false);
    f.context.mode = "tui";
    f.context.ui.custom = (factory) =>
        new Promise((resolve) => {
            const picker = factory(undefined, undefined, undefined, resolve);
            assert.ok(picker.render(90).join("\n").includes("Auxiliary model"));
            for (const character of "Auxiliary") picker.handleInput(character);
            picker.handleInput("\r");
        });
    await f.commands.get("approve-model").handler("", f.context);
    assert.deepEqual(f.extension.assertReady().options.settings.reviewModel, {
        provider: "fixture",
        id: "auxiliary",
    });
    assert.equal(f.context.model, main);
    await f.tools
        .get("write")
        .execute(
            "auxiliary-write",
            { path: target, content: "auxiliary-reviewed" },
            undefined,
            undefined,
            f.context,
        );
    assert.equal(f.requests.at(-1).selected, auxiliary);
    assert.equal(await readFile(target, "utf8"), "auxiliary-reviewed");
    f.context.mode = "rpc";
    f.context.ui.select = async (_title, choices) => choices[0];
    await f.commands.get("approve-model").handler("", f.context);
    assert.equal(f.extension.assertReady().options.settings.reviewModel, null);
    await f.tools
        .get("write")
        .execute(
            "current-write",
            { path: target, content: "main-reviewed" },
            undefined,
            undefined,
            f.context,
        );
    assert.equal(f.requests.at(-1).selected, main);
    assert.equal(await readFile(target, "utf8"), "main-reviewed");
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
    await assert.rejects(access(f.settingsPath));
    assert.equal(f.requests.length, 0);
    const withoutUI = { ...f.context, hasUI: false };
    await assert.rejects(
        f.commands.get("approve").handler("", withoutUI),
        (error) => error.code === "APPROVAL_UI_UNAVAILABLE",
    );
    await assert.rejects(
        f.commands.get("approve-model").handler("", withoutUI),
        (error) => error.code === "APPROVAL_UI_UNAVAILABLE",
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
    assert.equal(
        f.extension.assertReady().options.settings.approvalsReviewer,
        "user",
    );
    assert.deepEqual(f.extension.assertReady().options.settings.reviewModel, {
        id: "auxiliary",
        provider: "fixture",
    });
    f.context.mode = "tui";
    f.context.ui.custom = (factory) =>
        new Promise((resolve) =>
            factory(undefined, undefined, undefined, resolve).handleInput("\r"),
        );
    await f.commands.get("approve-model").handler("", f.context);
    assert.equal(await readFile(f.settingsPath, "utf8"), before);
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
    assert.equal(saved.approvalsReviewer, "user");
    assert.deepEqual(saved.reviewModel, {
        id: "auxiliary",
        provider: "fixture",
    });
    const broken = await setup(t);
    await mkdir(broken.settingsPath, { recursive: true });
    broken.context.ui.select = async (_title, choices) =>
        modeChoice(choices, "Ask for approval");
    await assert.rejects(
        broken.commands.get("approve").handler("", broken.context),
    );
    assert.equal(
        broken.extension.assertReady().options.settings.approvalsReviewer,
        "auto_review",
    );
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
    const rejected = assert.rejects(pending);
    await waiting;
    f.context.ui.select = async (_title, choices) =>
        modeChoice(choices, "Ask for approval");
    await f.commands.get("approve").handler("", f.context);
    finish('{"outcome":"allow"}');
    await rejected;
    assert.equal(await readFile(target, "utf8"), "unchanged");
});
test("[approval-settings] the actual mode picker renders Codex descriptions and all command UI in English", async (t) => {
    const f = await setup(t);
    initTheme("dark", false);
    f.context.mode = "tui";
    f.context.ui.select = async (title, choices) => {
        for (const description of Object.values(approvalDescriptions))
            assert.ok([title, ...choices].join("\n").includes(description));
        return modeChoice(choices, "Ask for approval");
    };
    f.context.ui.custom = (factory) =>
        new Promise((resolve) => {
            const picker = factory(undefined, undefined, undefined, resolve);
            const screen = stripVTControlCharacters(
                picker.render(120).join("\n"),
            );
            for (const description of Object.values(approvalDescriptions))
                assert.ok(screen.includes(description), screen);
            assert.doesNotMatch(screen, /[가-힣]/);
            picker.handleInput("\x1b[B");
            picker.handleInput("\r");
        });
    await f.commands.get("approve").handler("", f.context);
    assert.equal(
        f.extension.assertReady().options.settings.approvalsReviewer,
        "user",
    );
    assert.doesNotMatch(
        [...f.commands.values()]
            .map((command) => command.description)
            .join("\n"),
        /[가-힣]/,
    );
    assert.doesNotMatch(
        f.notifications.map(([text]) => text).join("\n"),
        /[가-힣]/,
    );
    f.context.ui.custom = (factory) =>
        new Promise((resolve) => {
            const picker = factory(undefined, undefined, undefined, resolve);
            const screen = stripVTControlCharacters(
                picker.render(36).join(" "),
            ).replace(/\s+/g, " ");
            assert.ok(
                screen.includes(approvalDescriptions["Ask for approval"]),
                screen,
            );
            picker.handleInput("\x1b");
        });
    await f.commands.get("approve").handler("", f.context);
    assert.equal(
        f.extension.assertReady().options.settings.approvalsReviewer,
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
        assert.equal(choices.length, 2);
        assert.ok(choices[0].startsWith("Use current Pi model"));
        assert.ok(choices[1].includes("fixture/auxiliary"));
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
            assert.ok(screen.includes("Auxiliary model"));
            assert.ok(!screen.includes("Main model"));
            assert.doesNotMatch(screen, /[가-힣]/);
            f.context.scopedModels = [{ model: main }];
            picker.handleInput("\r");
        });
    await assert.rejects(
        f.commands.get("approve-model").handler("", f.context),
        (error) => error.code === "MODEL_UNAVAILABLE",
    );
    assert.equal(await readFile(f.settingsPath, "utf8"), before);
    f.context.mode = "rpc";
    f.context.scopedModels = [{ model: { ...main, id: "unavailable" } }];
    f.context.ui.select = async (_title, choices) => {
        assert.equal(choices.length, 1);
        return undefined;
    };
    await f.commands.get("approve-model").handler("", f.context);
    f.context.scopedModels = [];
    f.context.ui.select = async (_title, choices) => {
        assert.equal(choices.length, 3);
        return undefined;
    };
    await f.commands.get("approve-model").handler("", f.context);
    assert.equal(await readFile(f.settingsPath, "utf8"), before);
    assert.doesNotMatch(JSON.stringify(screens), /[가-힣]/);
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
    assert.equal(choicesSeen.length, 1);
    assert.equal(choicesSeen[0].choices.length, 2);
    assert.ok(
        !choicesSeen[0].choices.some((choice) =>
            choice.includes("Excluded model"),
        ),
    );
    const target = join(f.outside, "sentinel.txt");
    await planStream(runtime.session, [
        [{ name: "write", args: { path: target, content: "approved" } }],
    ]);
    await runtime.session.prompt("Write only the owned outside sentinel.");
    assert.equal(await readFile(target, "utf8"), "approved");
    shouldAllow = false;
    await planStream(runtime.session, [
        [{ name: "write", args: { path: target, content: "denied" } }],
    ]);
    await runtime.session.prompt(
        "Repeat the owned fixture with the denial control.",
    );
    assert.equal(await readFile(target, "utf8"), "approved");
    assert.equal(requests.length, 2);
    assert.ok(requests.every((item) => item.model.id === "scoped-reviewer"));
    assert.equal(runtime.session.model.id, FAKE_MODEL.id);
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
    await assert.rejects(
        tool.execute("initial", args, undefined, undefined, f.context),
        (error) => error.code === "AUTO_REVIEW_DENIED",
    );
    f.context.ui.select = async (title, choices) => {
        assert.match(title, /denied action/);
        assert.match(choices[0], /exact overwrite/);
        return choices[0];
    };
    await f.commands.get("approve").handler("retry", f.context);
    assert.equal(sent.length, 1);
    assert.ok(
        sent[0].text.includes(JSON.stringify(args).slice(1, -1).split(",")[0]),
    );
    assert.equal(sent[0].options.expandPromptTemplates, false);
    assert.equal(
        f.extension.assertReady().options.settings.approvalsReviewer,
        "auto_review",
    );
    await tool.execute("retry", args, undefined, undefined, f.context);
    assert.equal(await readFile(args.path, "utf8"), "confirmed once");
    await assert.rejects(
        tool.execute("consumed", args, undefined, undefined, f.context),
        (error) => error.code === "AUTO_REVIEW_DENIED",
    );
    assert.equal(requests.length, 3);
    assert.equal(
        requests.filter((request) =>
            request.context.items.some(
                (item) => item.content?.type === "exact-action-retry-approval",
            ),
        ).length,
        1,
    );
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
                assert.match(title, /denied action/);
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
    assert.equal(await readFile(target, "utf8"), "unchanged");
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
    assert.equal(await readFile(target, "utf8"), "retried through Pi");
    assert.equal(requests.length, 2);
    assert.ok(
        requests[1].context.items.some(
            (item) => item.content?.type === "exact-action-retry-approval",
        ),
    );
    assert.ok(
        !requests[1].context.items.some(
            (item) =>
                item.source === "user" &&
                String(item.content).includes("controller holds a one-use"),
        ),
    );
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
    await assert.rejects(
        tool.execute("initial-critical", args, undefined, undefined, f.context),
        (error) => error.code === "AUTO_REVIEW_DENIED",
    );
    assert.equal(
        f.extension.assertReady().approvals.lifecycle.recentDenials[0]
            .assessment.risk_level,
        "critical",
    );
    await f.commands.get("approve").handler("retry", f.context);
    await tool.execute("risk-corrected", args, undefined, undefined, f.context);
    assert.equal(
        await readFile(args.path, "utf8"),
        "approved after reassessment",
    );
    hasCorrectedRisk = false;
    const next = { ...args, content: "must remain blocked" };
    await assert.rejects(
        tool.execute("another-critical", next, undefined, undefined, f.context),
        (error) => error.code === "AUTO_REVIEW_DENIED",
    );
    await f.commands.get("approve").handler("retry", f.context);
    await assert.rejects(
        tool.execute("still-critical", next, undefined, undefined, f.context),
        (error) => error.code === "AUTO_REVIEW_DENIED",
    );
    assert.equal(
        await readFile(args.path, "utf8"),
        "approved after reassessment",
    );
    assert.equal(requests.length, 4);
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
                    assert.ok(
                        data.context.items
                            .slice(0, confirmed)
                            .some(
                                (item) =>
                                    item.trust === "evidence" &&
                                    JSON.stringify(item.content).includes(
                                        "AUTO_REVIEW_DENIED",
                                    ),
                            ),
                    );
                    assert.ok(
                        !data.context.items.some(
                            (item) =>
                                item.content?.type ===
                                "exact-action-retry-approval",
                        ),
                    );
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
    assert.equal(await readFile(target, "utf8"), "unchanged");
    await planStream(runtime.session, step);
    await runtime.session.prompt(approval);
    assert.equal(await readFile(target, "utf8"), "confirmed-by-user");
    assert.equal(requests.length, 2);
});
