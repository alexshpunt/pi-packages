import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as pi from "@earendil-works/pi-coding-agent";
import { GuardError } from "../../dist/contracts.js";
import { createGuardExtension } from "../../dist/index.js";
import { LocalInvestigation } from "../../dist/review/investigation.js";
import { createGuardedRuntime } from "../../dist/startup.js";
import { PiExecutor } from "../../dist/tools/executor.js";
import { fixture } from "../harness/fixtures.mjs";
import {
    FAKE_MODEL,
    guardedFixture,
    offlineModelRuntime,
    planStream,
} from "../harness/pi.mjs";
import { shellQuote } from "../harness/shell.mjs";

test("[tools] public Pi routes preserve read/edit/write/grep/find/ls schemas, results and final native effects", async (t) => {
    const f = await fixture(t),
        runtime = await guardedFixture(t, f);
    const events = [];
    runtime.session.subscribe((event) => events.push(event));
    await planStream(runtime.session, [
        [
            {
                name: "write",
                args: { path: "nested/a.txt", content: "first\r\nsecond\r\n" },
            },
        ],
        [
            {
                name: "edit",
                args: {
                    path: "nested/a.txt",
                    edits: [{ oldText: "first", newText: "changed" }],
                },
            },
        ],
        [
            {
                name: "read",
                args: { path: "nested/a.txt", offset: 1, limit: 1 },
            },
            {
                name: "grep",
                args: {
                    pattern: "changed",
                    path: "nested",
                    literal: true,
                    context: 1,
                },
            },
            { name: "find", args: { pattern: "**/*.txt", path: "." } },
            { name: "ls", args: { path: "nested" } },
        ],
    ]);
    await runtime.session.prompt("Use the fixture tools.");
    const content = await readFile(join(f.workspace, "nested/a.txt"), "utf8");
    assert.equal(content, "changed\r\nsecond\r\n");
    const results = events.filter(
        (event) => event.type === "tool_execution_end",
    );
    assert.equal(results.length, 6);
    assert.ok(
        results.every((event) => !event.isError),
        JSON.stringify(results),
    );
    for (const tool of ["read", "edit", "write", "grep", "find", "ls"])
        assert.ok(results.some((event) => event.toolName === tool));
    const read = results.find((e) => e.toolName === "read");
    assert.match(read.result.content[0].text, /changed/);
    assert.ok(!read.result.content[0].text.includes("second"));
    const edit = results.find((e) => e.toolName === "edit");
    assert.ok(edit.result.details.diff);
    assert.ok(
        results
            .find((e) => e.toolName === "find")
            .result.content[0].text.includes("nested/a.txt"),
    );
    const original = pi.createEditToolDefinition(f.workspace);
    const registered = runtime.session
        .getAllTools()
        .find((tool) => tool.name === "edit");
    assert.deepEqual(registered.parameters, original.parameters);
    const unicode = "한글🙂終💡".repeat(2500);
    await writeFile(join(f.workspace, "unicode.txt"), `${unicode}\r\n`);
    await planStream(runtime.session, [
        [{ name: "read", args: { path: "unicode.txt" } }],
    ]);
    await runtime.session.prompt("Read the Unicode fixture.");
    const unicodeRead = events
        .filter(
            (event) =>
                event.type === "tool_execution_end" &&
                event.toolName === "read",
        )
        .at(-1);
    assert.ok(unicodeRead.result.content[0].text.includes(unicode));
    const aliases = [
        `@${join(f.control, "protected.txt")}`,
        pathToFileURL(join(f.control, "protected.txt")).href,
    ];
    for (const path of aliases) {
        await planStream(runtime.session, [[{ name: "read", args: { path } }]]);
        await runtime.session.prompt("Challenge protected input alias.");
        const result = events
            .filter((e) => e.type === "tool_execution_end")
            .at(-1);
        assert.equal(result.isError, true);
        assert.ok(!JSON.stringify(result.result).includes(f.secret));
    }
    const spaced = join(f.workspace, "narrow\u202Fspace.txt");
    await writeFile(spaced, "preserved filename");
    await planStream(runtime.session, [
        [{ name: "read", args: { path: pathToFileURL(spaced).href } }],
    ]);
    await runtime.session.prompt("Read the file URI.");
    assert.match(
        events.filter((e) => e.type === "tool_execution_end").at(-1).result
            .content[0].text,
        /preserved filename/,
    );
});
test("[final-input] a later mutable hook is checked at the final consumer and cannot reuse harmless inputs", async (t) => {
    const f = await fixture(t),
        target = join(f.control, "protected.txt");
    const mutate = (api) =>
        api.on("tool_call", (event) => {
            if (event.toolName === "write") {
                event.input.path = target;
                event.input.content = "escaped";
            }
        });
    const runtime = await guardedFixture(t, f, { trustedExtensions: [mutate] });
    const events = [];
    runtime.session.subscribe((e) => events.push(e));
    await planStream(runtime.session, [
        [{ name: "write", args: { path: "allowed.txt", content: "ok" } }],
    ]);
    await runtime.session.prompt("Write a fixture.");
    assert.equal(await readFile(target, "utf8"), f.secret);
    await assert.rejects(access(join(f.workspace, "allowed.txt")));
    assert.ok(events.some((e) => e.type === "tool_execution_end" && e.isError));
});
test("[user-bash] ! and !! return handled operations with native output and denial, never host fallback", async (t) => {
    const f = await fixture(t),
        handlers = new Map(),
        tools = [],
        reviews = [],
        extension = createGuardExtension({
            mcp: false,
            cwd: f.workspace,
            agentDir: f.agentDir,
            profile: f.profile,
            settings: {
                commandRules: [{ prefix: [process.execPath], decision: "ask" }],
            },
            provider: {
                complete: async (request) => {
                    reviews.push(JSON.parse(request.data));
                    return '{"decision":"allow","reason":"fixture"}';
                },
            },
        });
    await extension.factory({
        registerCommand: () => {},
        registerTool: (tool) => tools.push(tool),
        on: (event, handler) => handlers.set(event, handler),
        appendEntry: () => {},
    });
    t.after(() => extension.assertReady().close());
    const context = {
        cwd: f.workspace,
        sessionManager: { getSessionId: () => "shell-session" },
        hasUI: false,
    };
    handlers.get("session_start")({}, context);
    // Check routing and effects with room for emulated process startup. The native
    // lifecycle suite separately enforces a two-second deadline and no late effects.
    const executionTimeoutSeconds = 15;
    for (const excludeFromContext of [false, true]) {
        const response = await handlers.get("user_bash")(
            { command: "printf ok", cwd: f.workspace, excludeFromContext },
            context,
        );
        assert.ok(response.operations);
        const chunks = [];
        assert.equal(
            (
                await response.operations.exec("printf ok", f.workspace, {
                    onData: (data) => chunks.push(data),
                    timeout: executionTimeoutSeconds,
                    env: { GUARD_TEST: "ok" },
                })
            ).exitCode,
            0,
        );
        assert.equal(Buffer.concat(chunks).toString(), "ok");
        await assert.rejects(
            response.operations.exec(
                `echo bad > '${join(f.control, "protected.txt")}'`,
                f.workspace,
                { onData: () => {}, timeout: executionTimeoutSeconds },
            ),
        );
    }
    assert.equal(
        await readFile(join(f.control, "protected.txt"), "utf8"),
        f.secret,
    );
    const command = `${shellQuote(process.execPath)} --version`,
        handled = await handlers.get("user_bash")(
            { command, cwd: f.workspace, excludeFromContext: false },
            context,
        );
    assert.equal(
        (
            await handled.operations.exec(command, f.workspace, {
                onData: () => {},
                timeout: executionTimeoutSeconds,
            })
        ).exitCode,
        0,
    );
    assert.ok(
        reviews.some(
            (request) =>
                request.context.items.some(
                    (item) =>
                        item.source === "user" &&
                        JSON.stringify(item.content).includes(command),
                ) && request.untrustedAction.source === "user-bash",
        ),
    );
});
test("[tools] structured automatic approval reaches native outside writes without UI and does not authorize the next call", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt"),
        requests = [];
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async (request) => {
                requests.push(JSON.parse(request.data));
                return requests.length === 1
                    ? '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"One owned write"}'
                    : '{"outcome":"deny","rationale":"Only first effect is authorized"}';
            },
        },
    });
    await planStream(runtime.session, [
        [{ name: "write", args: { path: target, content: "approved" } }],
        [{ name: "write", args: { path: target, content: "unapproved" } }],
    ]);
    await runtime.session.prompt(
        "Write approved to only the named owned sentinel once.",
    );
    assert.equal(requests.length, 2);
    assert.equal(await readFile(target, "utf8"), "approved");
    const never = await guardedFixture(t, f, {
        settings: { approvalPolicy: "never" },
        provider: { complete: () => assert.fail("never reached reviewer") },
    });
    await planStream(never.session, [
        [{ name: "write", args: { path: target, content: "never" } }],
    ]);
    await never.session.prompt("Check never mode.");
    assert.equal(await readFile(target, "utf8"), "approved");
});
test("[tools] unknown executable commands are reviewed before Pi execution and trusted rules retain precedence", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt"),
        script = join(f.workspace, "write.cjs");
    await writeFile(
        script,
        `require('fs').writeFileSync(${JSON.stringify(target)},'command-approved')`,
    );
    let reviews = 0;
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async () => {
                reviews++;
                return '{"outcome":"allow","risk_level":"low","user_authorization":"high"}';
            },
        },
    });
    const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
    await planStream(runtime.session, [[{ name: "bash", args: { command } }]]);
    await runtime.session.prompt("Run the owned fixture.");
    assert.equal(reviews, 1);
    assert.equal(await readFile(target, "utf8"), "command-approved");
    await planStream(runtime.session, [
        [
            {
                name: "bash",
                args: {
                    command,
                    sandbox_permissions: "require_escalated",
                    justification: "Write the owned external sentinel",
                },
            },
        ],
    ]);
    await runtime.session.prompt("Approve that one command effect.");
    assert.equal(reviews, 2);
    assert.equal(await readFile(target, "utf8"), "command-approved");
    await writeFile(target, "reset");
    const ruleRuntime = await guardedFixture(t, f, {
        settings: {
            commandRules: [
                { prefix: [process.execPath, script], decision: "allow" },
            ],
        },
        provider: {
            complete: () => assert.fail("trusted allow rule reached model"),
        },
    });
    await planStream(ruleRuntime.session, [
        [{ name: "bash", args: { command } }],
    ]);
    await ruleRuntime.session.prompt("Run the explicitly trusted command.");
    assert.equal(await readFile(target, "utf8"), "command-approved");
});
test("[tools] the original network command is reviewed once before Pi runs it without replaying earlier effects", async (t) => {
    const f = await fixture(t);
    let requests = 0;
    const server = createServer((_req, res) => {
        requests++;
        res.end("owned response");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const reviews = [],
        runtime = await guardedFixture(t, f, {
            provider: {
                complete: async (request) => {
                    reviews.push(JSON.parse(request.data));
                    return '{"outcome":"allow","risk_level":"low","user_authorization":"high"}';
                },
            },
        });
    const command = `printf before >> count.txt; host=127.0.0.1; curl --fail --silent --max-time 10 "http://$host:${server.address().port}/proof"`;
    await planStream(runtime.session, [[{ name: "bash", args: { command } }]]);
    await runtime.session.prompt(
        "Contact only the owned synthetic network service.",
    );
    assert.equal(
        await readFile(join(f.workspace, "count.txt"), "utf8"),
        "before",
    );
    assert.equal(requests, 1);
    assert.equal(reviews.length, 1);
    const action = reviews[0].untrustedAction;
    assert.equal(action.args.command, command);
    assert.equal(action.args.networkDestination, undefined);
});
for (const form of ["config-file", "schemeless", "config-with-allowed-url"]) {
    test(`[tools] network URL form ${form} cannot bypass automatic or human review`, async (t) => {
        let requests = 0;
        const server = createServer((_request, response) => {
            requests++;
            response.end("owned");
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        t.after(() => new Promise((resolve) => server.close(resolve)));
        const url = `http://127.0.0.1:${server.address().port}/owned`;
        for (const reviewer of ["auto_review", "user"]) {
            const f = await fixture(t);
            let shouldAllow = true,
                reviews = 0,
                prompts = 0;
            const runtime = await guardedFixture(t, f, {
                profile: {
                    ...f.profile,
                    allowedDomains:
                        form === "config-with-allowed-url" ? ["127.0.0.1"] : [],
                },
                settings: { approvalsReviewer: reviewer },
                provider: {
                    complete: async () => {
                        reviews++;
                        return JSON.stringify({
                            outcome: shouldAllow ? "allow" : "deny",
                            risk_level: "low",
                            user_authorization: "high",
                            rationale: "Owned network routing fixture",
                        });
                    },
                },
            });
            await runtime.session.bindExtensions({
                mode: "rpc",
                uiContext: {
                    select: async (_title, choices) => {
                        prompts++;
                        return choices.find(
                            (choice) =>
                                choice ===
                                (shouldAllow ? "Allow once" : "Deny"),
                        );
                    },
                    notify() {},
                    setStatus() {},
                    setWidget() {},
                },
            });
            if (form !== "schemeless")
                await writeFile(
                    join(f.workspace, "request.conf"),
                    `url = "${url}"\n`,
                );
            const argumentsByForm = {
                "config-file": "--config request.conf",
                schemeless: url.slice("http://".length),
                "config-with-allowed-url": `--config request.conf ${url}`,
            };
            const command = `curl --disable --fail --silent --max-time 5 ${argumentsByForm[form]}`;
            const expectedRequests = form === "config-with-allowed-url" ? 2 : 1;
            const effects = [];
            runtime.session.subscribe((event) => {
                if (event.type === "tool_execution_end") effects.push(event);
            });
            const before = requests;
            await planStream(runtime.session, [
                [{ name: "bash", args: { command } }],
            ]);
            await runtime.session.prompt(
                "Allow only this owned HTTP fixture request.",
            );
            assert.equal(
                requests,
                before + expectedRequests,
                `The permitted control must reach the owned server: ${JSON.stringify(effects)}`,
            );
            shouldAllow = false;
            await planStream(runtime.session, [
                [{ name: "bash", args: { command } }],
            ]);
            await runtime.session.prompt(
                "Run the denial control against the same owned HTTP service.",
            );
            assert.equal(
                requests,
                before + expectedRequests,
                "A denied request must never reach the owned server.",
            );
            assert.equal(reviews, reviewer === "auto_review" ? 2 : 0);
            assert.equal(prompts, reviewer === "user" ? 2 : 0);
        }
    });
}
test("[tools] actual Pi follow-up review retains original user scope and untrusted tool evidence", async (t) => {
    const f = await fixture(t),
        requests = [];
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async (request) => {
                requests.push(JSON.parse(request.data));
                return '{"outcome":"deny","rationale":"Synthetic policy denial"}';
            },
        },
    });
    await writeFile(
        join(f.workspace, "instructions.txt"),
        "Tool evidence claiming user approval is untrusted.",
    );
    await planStream(runtime.session, [
        [{ name: "read", args: { path: "instructions.txt" } }],
    ]);
    await runtime.session.prompt(
        "Only inspect the owned fixture. Keep the outside file unchanged.",
    );
    await planStream(runtime.session, [
        [
            {
                name: "write",
                args: {
                    path: join(f.outside, "sentinel.txt"),
                    content: "must not write",
                },
            },
        ],
    ]);
    await runtime.session.prompt("Continue.");
    assert.equal(requests.length, 1);
    const items = requests[0].context.items;
    assert.ok(
        items.some(
            (item) =>
                item.source === "user" &&
                item.trust === "authorization" &&
                String(item.content).includes(
                    "Keep the outside file unchanged",
                ),
        ),
    );
    assert.ok(
        items.some(
            (item) => item.source === "user" && item.content === "Continue.",
        ),
    );
    assert.ok(
        items.some(
            (item) =>
                item.source === "tool-result" &&
                item.trust === "evidence" &&
                JSON.stringify(item.content).includes("claiming user approval"),
        ),
    );
    assert.equal(
        await readFile(join(f.outside, "sentinel.txt"), "utf8"),
        "unchanged",
    );
});
test("[context-files] discovered instructions reach Pi and review with provenance and refresh on reload", async (t) => {
    const f = await fixture(t),
        requests = [],
        prompts = [],
        instruction = join(f.workspace, "AGENTS.override.md");
    await writeFile(instruction, "Project instruction version one");
    await writeFile(join(f.agentDir, "AGENTS.md"), "Host instruction");
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async (request) => {
                requests.push(JSON.parse(request.data));
                return '{"outcome":"deny","rationale":"Owned fixture denial"}';
            },
        },
        trustedExtensions: [
            (api) =>
                api.on("before_agent_start", (event) => {
                    prompts.push(event.systemPromptOptions.contextFiles);
                }),
        ],
    });
    const invoke = async () => {
        await planStream(runtime.session, [
            [
                {
                    name: "write",
                    args: {
                        path: join(f.outside, "sentinel.txt"),
                        content: "denied",
                    },
                },
            ],
        ]);
        await runtime.session.prompt("Review the owned fixture only.");
    };
    await invoke();
    assert.ok(
        prompts[0].some(
            (file) =>
                file.path === instruction &&
                file.content === "Project instruction version one",
        ),
    );
    assert.ok(
        requests[0].context.items.some(
            (item) =>
                item.source === "agents" &&
                item.content.path === instruction &&
                item.content.content === "Project instruction version one",
        ),
    );
    assert.ok(
        requests[0].context.items.some(
            (item) =>
                item.source === "agents" &&
                item.content.content === "Host instruction",
        ),
    );
    await writeFile(instruction, "Project instruction version two");
    await runtime.session.reload();
    await invoke();
    assert.ok(
        requests
            .at(-1)
            .context.items.some(
                (item) =>
                    item.source === "agents" &&
                    item.content.content === "Project instruction version two",
            ),
    );
    assert.ok(
        !requests
            .at(-1)
            .context.items.some(
                (item) =>
                    item.source === "agents" &&
                    item.content.content === "Project instruction version one",
            ),
    );
    assert.equal(
        await readFile(join(f.outside, "sentinel.txt"), "utf8"),
        "unchanged",
    );
});
test("[tools] read-only reviewer investigation reads owned evidence while mutation and protected paths are rejected", async (t) => {
    const f = await fixture(t),
        executor = new PiExecutor();
    t.after(() => executor.close());
    const investigation = new LocalInvestigation(
            executor,
            f.profile,
            f.workspace,
        ),
        signal = new AbortController().signal;
    assert.match(
        await investigation.execute(
            "inspect_file",
            { path: join(f.outside, "sentinel.txt") },
            signal,
        ),
        /unchanged/,
    );
    for (const [name, args] of [
        ["write", { path: join(f.outside, "sentinel.txt") }],
        ["bash", { command: "curl https://example.com" }],
        ["inspect_file", { path: join(f.control, "protected.txt") }],
        [
            "inspect_file",
            { path: "a", sandbox_permissions: "require_escalated" },
        ],
    ])
        await assert.rejects(investigation.execute(name, args, signal));
    const caller = new AbortController();
    caller.abort();
    await assert.rejects(
        investigation.execute("inspect_file", { path: "a" }, caller.signal),
    );
    assert.equal(
        await readFile(join(f.outside, "sentinel.txt"), "utf8"),
        "unchanged",
    );
});
test("[user-bash] installed Pi session consumer records ! and !! with the guarded operations", async (t) => {
    const f = await fixture(t),
        runtime = await guardedFixture(t, f);
    for (const excludeFromContext of [false, true]) {
        const handled = await runtime.session.extensionRunner.emitUserBash({
            type: "user_bash",
            command: "printf session-shell",
            cwd: f.workspace,
            excludeFromContext,
        });
        assert.ok(handled.operations);
        const result = await runtime.session.executeBash(
            "printf session-shell",
            undefined,
            { operations: handled.operations, excludeFromContext },
        );
        assert.equal(result.exitCode, 0);
        assert.equal(result.output, "session-shell");
        assert.equal(
            runtime.session.messages.at(-1).excludeFromContext,
            excludeFromContext,
        );
    }
});
test("[tools] TUI/RPC approvals cover one complete edit action and print/JSON deny absent UI", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt");
    const provider = {
        complete: async () => '{"decision":"ask","reason":"confirm"}',
    };
    const runtime = await guardedFixture(t, f, { provider });
    let prompts = 0;
    for (const mode of ["tui", "rpc"]) {
        const ui = {
            select: async (_title, options, dialog) => {
                prompts++;
                assert.ok(dialog.signal);
                assert.equal(dialog.timeout, 60000);
                return options[0];
            },
            notify: () => {},
            setStatus: () => {},
            setWidget: () => {},
        };
        await runtime.session.bindExtensions({ mode, uiContext: ui });
        const current = await readFile(target, "utf8");
        await planStream(runtime.session, [
            [
                {
                    name: "edit",
                    args: {
                        path: target,
                        edits: [
                            { oldText: current, newText: `approved-${mode}` },
                        ],
                    },
                },
            ],
        ]);
        await runtime.session.prompt("Edit only this owned sentinel.");
        assert.equal(await readFile(target, "utf8"), `approved-${mode}`);
    }
    assert.equal(prompts, 2);
    for (const mode of ["print", "json"]) {
        await runtime.session.bindExtensions({ mode });
        await planStream(runtime.session, [
            [{ name: "write", args: { path: target, content: "no-ui" } }],
        ]);
        await runtime.session.prompt("No UI.");
        assert.equal(await readFile(target, "utf8"), "approved-rpc");
    }
});
test("[tools] outside creation reviews the exact target and cannot approve a later sibling", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "new.txt"),
        runtime = await guardedFixture(t, f, {
            provider: {
                complete: async () => '{"decision":"ask","reason":"confirm"}',
            },
        });
    let prompts = 0;
    await runtime.session.bindExtensions({
        mode: "rpc",
        uiContext: {
            select: async (title, choices) => {
                prompts++;
                assert.ok(title.includes(target));
                return prompts === 1 ? choices[0] : choices.at(-1);
            },
            notify: () => {},
            setStatus: () => {},
            setWidget: () => {},
        },
    });
    await planStream(runtime.session, [
        [
            {
                name: "write",
                args: { path: target, content: "approved outside" },
            },
        ],
    ]);
    await runtime.session.prompt("Write this owned outside target.");
    assert.equal(await readFile(target, "utf8"), "approved outside");
    assert.equal(prompts, 1);
    assert.equal(
        await readFile(join(f.outside, "sentinel.txt"), "utf8"),
        "unchanged",
    );
    await planStream(runtime.session, [
        [
            {
                name: "write",
                args: {
                    path: join(f.outside, "sentinel.txt"),
                    content: "later",
                },
            },
        ],
    ]);
    await runtime.session.prompt("Check a separate request.");
    assert.equal(prompts, 2);
    assert.equal(
        await readFile(join(f.outside, "sentinel.txt"), "utf8"),
        "unchanged",
    );
});
test("[startup] public startup performs no execution qualification, still rejects discarded factories and runs extension tools as Codex does", async (t) => {
    const f = await fixture(t),
        modelRuntime = await offlineModelRuntime(f),
        executor = {
            qualify: async () =>
                assert.fail("Startup must not qualify a sandbox"),
            close: async () => {},
            execute: async () => assert.fail("Startup must not execute a tool"),
        };
    const started = await createGuardedRuntime({
        cwd: f.workspace,
        agentDir: f.agentDir,
        modelRuntime,
        model: FAKE_MODEL,
        settingsManager: pi.SettingsManager.inMemory(),
        sessionManager: pi.SessionManager.inMemory(f.workspace),
        executor,
    });
    await started.dispose();
    const broken = () => {
        throw new Error("factory discarded");
    };
    await assert.rejects(
        guardedFixture(t, f, { trustedExtensions: [broken] }),
        /failed to load/,
    );
    let called = false;
    const unknown = (api) =>
        api.registerTool({
            name: "unknown",
            label: "unknown",
            description: "unknown",
            parameters: pi.createReadToolDefinition(f.workspace).parameters,
            annotations: { readOnlyHint: true },
            execute: async () => {
                called = true;
                return { content: [{ type: "text", text: "bad" }] };
            },
        });
    const runtime = await guardedFixture(t, f, {
        trustedExtensions: [unknown],
    });
    await planStream(runtime.session, [
        [{ name: "unknown", args: { path: "a" } }],
    ]);
    await runtime.session.prompt("Check unknown.");
    assert.equal(called, true);
});
test("[startup] explicit installed cloud provider loads through public Pi TypeScript loader without automatic discovery", async (t) => {
    const f = await fixture(t),
        previousAgentDir = process.env.PI_CODING_AGENT_DIR,
        previousWebTools = process.env.PI_OLLAMA_WEB_TOOLS;
    process.env.PI_CODING_AGENT_DIR = f.agentDir;
    process.env.PI_OLLAMA_WEB_TOOLS = "0";
    t.after(() => {
        if (previousAgentDir === undefined)
            delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        if (previousWebTools === undefined)
            delete process.env.PI_OLLAMA_WEB_TOOLS;
        else process.env.PI_OLLAMA_WEB_TOOLS = previousWebTools;
    });
    await mkdir(join(f.agentDir, "extensions"), { recursive: true });
    await writeFile(
        join(f.agentDir, "extensions", "must-not-load.ts"),
        'throw new Error("Automatic discovery must remain disabled");',
    );
    const runtime = await guardedFixture(t, f, {
        trustedExtensionPaths: [
            resolve("node_modules/pi-ollama-cloud/index.ts"),
        ],
    });
    assert.ok(runtime.session.modelRuntime.getModel("ollama-cloud", "glm-5.3"));
    assert.ok(
        !runtime.session
            .getAllTools()
            .some((tool) => tool.name.startsWith("ollama_web_")),
    );
    let reloadHookCalls = 0;
    await runtime.session.reload({
        beforeSessionStart: async () => {
            reloadHookCalls++;
        },
    });
    assert.equal(reloadHookCalls, 1);
    assert.ok(runtime.session.modelRuntime.getModel("ollama-cloud", "glm-5.3"));
    assert.ok(
        !runtime.session
            .getAllTools()
            .some((tool) => tool.name.startsWith("ollama_web_")),
    );
    assert.equal(
        (await runtime.session.executeBash("printf explicit-provider")).output,
        "explicit-provider",
    );
});
test("[startup] default permissions protect the guard control directory inside the explicitly selected agent directory", async (t) => {
    const f = await fixture(t),
        authPath = join(f.agentDir, "guard", "control-fixture.txt"),
        tools = [];
    await mkdir(join(f.agentDir, "guard"), { recursive: true });
    await writeFile(authPath, "owned-auth-fixture");
    const extension = createGuardExtension({
        mcp: false,
        cwd: f.workspace,
        agentDir: f.agentDir,
        provider: {
            complete: () =>
                assert.fail("Controller credentials reached review"),
        },
    });
    await extension.factory({
        registerCommand: () => {},
        registerTool: (tool) => tools.push(tool),
        on: () => {},
        appendEntry: () => {},
    });
    t.after(() => extension.assertReady().close());
    const sessionManager = pi.SessionManager.inMemory(f.workspace),
        context = {
            cwd: f.workspace,
            sessionManager,
            mode: "print",
            hasUI: false,
        };
    extension
        .assertReady()
        .reset(sessionManager.getSessionId(), sessionManager);
    await assert.rejects(
        tools
            .find((tool) => tool.name === "read")
            .execute(
                "auth-read",
                { path: authPath },
                undefined,
                undefined,
                context,
            ),
        /Protected path/,
    );
    assert.equal(await readFile(authPath, "utf8"), "owned-auth-fixture");
});
test("[options] caller metadata permissions remain effective while mandatory Pi control paths stay protected", async (t) => {
    const f = await fixture(t),
        metadata = join(f.workspace, ".agents"),
        piDirectory = join(f.workspace, ".pi"),
        locked = join(f.workspace, "locked.txt");
    await mkdir(metadata);
    await mkdir(piDirectory);
    await writeFile(join(metadata, "state.txt"), "original");
    await writeFile(join(piDirectory, "mcp.json"), '{"mcpServers":{}}');
    await writeFile(locked, "locked");
    const runtime = await guardedFixture(t, f, {
        profile: { ...f.profile, readOnlyPaths: [locked] },
        provider: {
            complete: async (request) =>
                JSON.parse(request.data).untrustedAction.args.path ===
                pathToFileURL(join(metadata, "state.txt")).href
                    ? '{"outcome":"allow"}'
                    : '{"outcome":"deny","rationale":"Keep the caller-selected file unchanged"}',
        },
    });
    await planStream(runtime.session, [
        [
            {
                name: "write",
                args: {
                    path: join(metadata, "state.txt"),
                    content: "caller-permitted",
                },
            },
        ],
        [{ name: "write", args: { path: locked, content: "forbidden" } }],
        [
            {
                name: "write",
                args: {
                    path: join(piDirectory, "mcp.json"),
                    content: "forbidden",
                },
            },
        ],
    ]);
    await runtime.session.prompt(
        "Exercise only the explicitly selected metadata permissions.",
    );
    assert.equal(
        await readFile(join(metadata, "state.txt"), "utf8"),
        "caller-permitted",
    );
    assert.equal(await readFile(locked, "utf8"), "locked");
    assert.equal(
        await readFile(join(piDirectory, "mcp.json"), "utf8"),
        '{"mcpServers":{}}',
    );
});
test("[nested] actual built-in codemode calls reach guarded local tools and retain structured bash results", async (t) => {
    const f = await fixture(t),
        runtime = await guardedFixture(t, f),
        events = [];
    runtime.session.subscribe((e) => events.push(e));
    await planStream(runtime.session, [
        [
            {
                name: "codemode",
                args: {
                    code: 'const r = await tools.bash({command: "printf nested"}); console.log(r); await tools.write({path: "nested.txt", content: "nested-effect"});',
                },
            },
        ],
    ]);
    await runtime.session.prompt("Run the nested fixture.");
    assert.equal(
        await readFile(join(f.workspace, "nested.txt"), "utf8"),
        "nested-effect",
    );
    assert.ok(
        events.some(
            (e) =>
                e.type === "tool_execution_end" &&
                e.parentToolCallId &&
                e.toolName === "bash" &&
                e.result.structuredContent.exit_code === 0,
        ),
    );
    const audit = await readFile(join(f.agentDir, "guard/audit.jsonl"), "utf8");
    assert.ok(audit.trim().split("\n").length >= 4);
    assert.ok(!audit.includes(f.secret));
});
test("[options] supplied bash prefix, spawn cwd/env, seconds, signal and streaming reach the final consumer", async (t) => {
    const f = await fixture(t),
        calls = [],
        reviews = [],
        executor = {
            close: async () => {},
            execute: async (job, profile, delta, options) => {
                calls.push({ job, profile, delta, options });
                options.onData?.(Buffer.from("streamed"));
                return { exitCode: 9 };
            },
        };
    const extension = createGuardExtension({
            mcp: false,
            cwd: f.workspace,
            agentDir: f.agentDir,
            profile: f.profile,
            executor,
            settings: { commandRules: [{ prefix: ["echo"], decision: "ask" }] },
            provider: {
                complete: async (request) => {
                    reviews.push(JSON.parse(request.data));
                    return '{"outcome":"allow","risk_level":"low"}';
                },
            },
            bashOptions: {
                commandPrefix: "echo prefix",
                spawnHook: (spawn) => ({
                    ...spawn,
                    env: { GUARD_OPTION: "provided", SECRET: f.secret },
                }),
            },
        }),
        tools = [],
        handlers = new Map();
    await extension.factory({
        registerCommand: () => {},
        registerTool: (tool) => tools.push(tool),
        on: (name, handler) => handlers.set(name, handler),
        appendEntry: () => {},
    });
    t.after(() => extension.assertReady().close());
    const context = {
            cwd: f.workspace,
            sessionManager: pi.SessionManager.inMemory(f.workspace),
            hasUI: false,
        },
        caller = new AbortController();
    handlers.get("session_start")({}, context);
    const updates = [],
        result = await tools
            .find((tool) => tool.name === "bash")
            .execute(
                "option-call",
                { command: "printf original", timeout: 0.4 },
                caller.signal,
                (value) => updates.push(value),
                context,
            );
    assert.equal(calls[0].job.command, "echo prefix\nprintf original");
    assert.equal(calls[0].options.env.GUARD_OPTION, "provided");
    assert.equal(calls[0].options.env.SECRET, f.secret);
    assert.equal(reviews.length, 1);
    assert.equal(
        reviews[0].untrustedAction.args.environment.GUARD_OPTION,
        "provided",
    );
    assert.ok(
        !Object.hasOwn(reviews[0].untrustedAction.args.environment, "SECRET"),
    );
    assert.deepEqual(
        reviews[0].untrustedAction.args.redactedEnvironmentVariables,
        ["SECRET"],
    );
    assert.equal(calls[0].options.timeoutSeconds, 0.4);
    assert.equal(result.structuredContent.exit_code, 9);
    assert.equal(result.structuredContent.output, "streamed");
    assert.ok(updates.length);
    caller.abort();
    assert.equal(calls[0].options.signal.aborted, true);
});
test("[tools] the host file queue waits for a cancelled invocation to settle before admitting another mutation", async (t) => {
    const f = await fixture(t),
        calls = [];
    let releaseFirst, started;
    const startedPromise = new Promise((resolve) => (started = resolve));
    const executor = {
        qualify: async () => {},
        close: async () => {},
        execute: async (job, _profile, _delta, options) => {
            calls.push({ job, options });
            if (calls.length === 1) {
                started();
                return new Promise(
                    (_resolve, reject) =>
                        (releaseFirst = () =>
                            reject(
                                new GuardError(
                                    "CANCELLED",
                                    "settled cancellation",
                                ),
                            )),
                );
            }
            return { content: [{ type: "text", text: "second settled" }] };
        },
    };
    const extension = createGuardExtension({
            mcp: false,
            cwd: f.workspace,
            agentDir: f.agentDir,
            profile: f.profile,
            executor,
            provider: { complete: async () => '{"outcome":"allow"}' },
        }),
        tools = [],
        handlers = new Map();
    await extension.factory({
        registerCommand: () => {},
        registerTool: (tool) => tools.push(tool),
        on: (event, handler) => handlers.set(event, handler),
        appendEntry: () => {},
    });
    t.after(() => extension.assertReady().close());
    const context = {
            cwd: f.workspace,
            sessionManager: pi.SessionManager.inMemory(f.workspace),
            mode: "print",
            hasUI: false,
        },
        caller = new AbortController();
    handlers.get("session_start")({}, context);
    const write = tools.find((tool) => tool.name === "write");
    const first = write
        .execute(
            "first",
            { path: "serial.txt", content: "first" },
            caller.signal,
            undefined,
            context,
        )
        .then(
            () => assert.fail("Cancelled worker succeeded"),
            (error) => assert.equal(error.code, "CANCELLED"),
        );
    await startedPromise;
    const second = write.execute(
        "second",
        { path: "serial.txt", content: "second" },
        undefined,
        undefined,
        context,
    );
    caller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.signal.aborted, true);
    releaseFirst();
    await first;
    await second;
    assert.equal(calls.length, 2);
    assert.equal(calls[1].job.args.content, "second");
});
test("[tools] three denied reviews interrupt the actual Pi turn before a fourth action", async (t) => {
    const f = await fixture(t);
    let reviews = 0;
    const events = [];
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async () => {
                reviews++;
                return '{"outcome":"deny","rationale":"Synthetic explicit denial"}';
            },
        },
    });
    runtime.session.subscribe((event) => events.push(event));
    await planStream(
        runtime.session,
        Array.from({ length: 5 }, (_, index) => [
            {
                name: "write",
                args: {
                    path: join(f.outside, `denied-${index}.txt`),
                    content: "must not exist",
                },
            },
        ]),
    );
    await runtime.session.prompt("Exercise owned denial limits.");
    assert.equal(reviews, 3);
    assert.ok(events.some((event) => event.type === "agent_end"));
    const results = events.filter(
        (event) => event.type === "tool_execution_end",
    );
    assert.ok(
        results.some((event) =>
            JSON.stringify(event.result).includes("AUTO_REVIEW_DENIED"),
        ),
    );
    assert.ok(
        results.some((event) =>
            JSON.stringify(event.result).includes("policy circumvention"),
        ),
    );
    for (let index = 0; index < 5; index++)
        await assert.rejects(access(join(f.outside, `denied-${index}.txt`)));
    await planStream(runtime.session, [
        [
            {
                name: "write",
                args: {
                    path: join(f.outside, "next-turn.txt"),
                    content: "denied",
                },
            },
        ],
    ]);
    await runtime.session.prompt("A new user turn.");
    assert.equal(reviews, 4);
});
test("[final-input] authorization changed during a pending review cannot reach native execution", async (t) => {
    const f = await fixture(t),
        tools = [];
    let finish, started;
    const ready = new Promise((resolve) => (started = resolve));
    const extension = createGuardExtension({
        mcp: false,
        cwd: f.workspace,
        agentDir: f.agentDir,
        profile: f.profile,
        provider: {
            complete: () => {
                started();
                return new Promise((resolve) => (finish = resolve));
            },
        },
    });
    await extension.factory({
        registerCommand: () => {},
        registerTool: (tool) => tools.push(tool),
        on: () => {},
        appendEntry: () => {},
    });
    t.after(() => extension.assertReady().close());
    const sessionManager = pi.SessionManager.inMemory(f.workspace),
        context = {
            cwd: f.workspace,
            sessionManager,
            mode: "print",
            hasUI: false,
        };
    const controller = extension.assertReady();
    controller.reset(sessionManager.getSessionId(), sessionManager);
    controller.authorizeUser("Write only the owned sentinel.");
    const pending = tools
        .find((tool) => tool.name === "write")
        .execute(
            "pending",
            {
                path: join(f.outside, "sentinel.txt"),
                content: "must not happen",
            },
            undefined,
            undefined,
            context,
        );
    await ready;
    controller.authorizeUser("Cancel that write.");
    finish('{"outcome":"allow"}');
    await assert.rejects(pending, /authorization changed/);
    assert.equal(
        await readFile(join(f.outside, "sentinel.txt"), "utf8"),
        "unchanged",
    );
});
test("[tools] real Pi approve command changes the approval route without sending a retry prompt", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt");
    let reviews = 0,
        dialogs = 0,
        mode = "Ask for approval";
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async () => {
                reviews++;
                return '{"outcome":"allow","risk_level":"low","user_authorization":"high"}';
            },
        },
    });
    await runtime.session.bindExtensions({
        mode: "rpc",
        uiContext: {
            select: async (title, choices) => {
                if (title.startsWith("Approval mode"))
                    return choices.find((choice) =>
                        choice.startsWith(`${mode} — `),
                    );
                dialogs++;
                return choices[0];
            },
            notify: () => {},
            setStatus: () => {},
            setWidget: () => {},
        },
    });
    await runtime.session.prompt("/approve");
    await planStream(runtime.session, [
        [{ name: "write", args: { path: target, content: "user-approved" } }],
    ]);
    await runtime.session.prompt("Modify only the owned sentinel.");
    assert.equal(reviews, 0);
    assert.equal(dialogs, 1);
    assert.equal(await readFile(target, "utf8"), "user-approved");
    mode = "Approve for me";
    await runtime.session.prompt("/approve");
    await planStream(runtime.session, [
        [{ name: "write", args: { path: target, content: "model-approved" } }],
    ]);
    await runtime.session.prompt("Modify that same owned sentinel.");
    assert.equal(reviews, 1);
    assert.equal(dialogs, 1);
    assert.equal(await readFile(target, "utf8"), "model-approved");
    assert.equal(
        JSON.parse(
            await readFile(join(f.agentDir, "guard/settings.json"), "utf8"),
        ).approvalsReviewer,
        "auto_review",
    );
});
