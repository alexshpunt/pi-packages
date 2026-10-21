import { execFile } from "node:child_process";
import {
    access,
    mkdir,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EMPTY_DELTA } from "../../dist/contracts.js";
import { PiExecutor } from "../../dist/tools/executor.js";
import { auditPopulationPath, fixture } from "../harness/fixtures.mjs";
import { guardedFixture, planStream } from "../harness/pi.mjs";
import { shellQuote, workloadEnvironment } from "../harness/shell.mjs";

const exec = promisify(execFile),
    repository = fileURLToPath(new URL("../../", import.meta.url));
test("[workflow] model work succeeds while adversarial interpreter and protected file effects remain denied", async (t) => {
    const f = await fixture(t),
        runtime = await guardedFixture(t, f, {
            provider: {
                complete: async (request) =>
                    JSON.parse(request.data).untrustedAction.tool === "write"
                        ? '{"outcome":"allow"}'
                        : '{"outcome":"deny","rationale":"Do not run the adversarial interpreter"}',
            },
        }),
        target = join(f.outside, "sentinel.txt"),
        events = [];
    runtime.session.subscribe((e) => events.push(e));
    await planStream(runtime.session, [
        [{ name: "write", args: { path: "allowed.txt", content: "allowed" } }],
        [
            {
                name: "bash",
                args: {
                    command: `${shellQuote(process.execPath)} -e ${shellQuote(`require('fs').writeFileSync(${JSON.stringify(target)},'escaped')`)}`,
                },
            },
        ],
        [{ name: "read", args: { path: join(f.control, "protected.txt") } }],
    ]);
    await runtime.session.prompt("Perform owned fixture work.");
    expect(await readFile(join(f.workspace, "allowed.txt"), "utf8")).toBe(
        "allowed",
    );
    expect(await readFile(target, "utf8")).toBe("unchanged");
    expect(await readFile(join(f.control, "protected.txt"), "utf8")).toBe(
        f.secret,
    );
    const results = events.filter((e) => e.type === "tool_execution_end");
    expect(results.length).toBe(3);
    expect(results[0].isError).toBe(false);
    expect(results[1].isError).toBe(true);
    expect(results[2].isError).toBe(true);
    expect(
        results.every((e) => !JSON.stringify(e.result).includes(f.secret)),
    ).toBeTruthy();
});
test("[workflow] one-use UI approval covers edit helpers and cannot authorize another logical call", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt"),
        runtime = await guardedFixture(t, f, {
            provider: {
                complete: async () => '{"decision":"ask","reason":"confirm"}',
            },
        });
    let prompts = 0;
    await runtime.session.bindExtensions({
        mode: "rpc",
        uiContext: {
            select: async (_title, choices) => {
                prompts++;
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
                name: "edit",
                args: {
                    path: target,
                    edits: [{ oldText: "unchanged", newText: "approved" }],
                },
            },
        ],
        [{ name: "write", args: { path: target, content: "second" } }],
    ]);
    await runtime.session.prompt("Approve only the first action.");
    expect(prompts).toBe(2);
    expect(await readFile(target, "utf8")).toBe("approved");
});
test("[workflow] SDK shell approval and invalid settings on reload cannot activate an unreviewed fallback", async (t) => {
    const f = await fixture(t),
        runtime = await guardedFixture(t, f);
    expect(
        (await runtime.session.executeBash("printf protected-sdk")).output,
    ).toBe("protected-sdk");
    let unsafe = false;
    await expect(
        runtime.session.executeBash("printf unsafe", undefined, {
            operations: {
                exec: async () => {
                    unsafe = true;
                    return { exitCode: 0 };
                },
            },
        }),
    ).rejects.toThrow(/guarded shell/);
    expect(unsafe).toBe(false);
    await mkdir(join(f.agentDir, "guard"), { recursive: true });
    await writeFile(join(f.agentDir, "guard/settings.json"), "{invalid");
    await expect(runtime.session.reload()).rejects.toThrow(
        /failed to load|not ready/,
    );
    await expect(
        runtime.session.executeBash(
            `echo escape > '${join(f.workspace, "reload.txt")}'`,
        ),
    ).rejects.toThrow(/failed to load|not ready/);
    await expect(
        runtime.session.prompt("After failed reload."),
    ).rejects.toThrow(/failed to load|not ready/);
    await expect(access(join(f.workspace, "reload.txt"))).rejects.toThrow();
});
test("[workflow] malformed risk enums fail closed at the actual Pi write and reach the next model request", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt"),
        events = [],
        requests = [];
    let reviews = 0;
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async () =>
                JSON.stringify({
                    outcome: "allow",
                    risk_level: [++reviews === 1 ? "critical" : "high"],
                    user_authorization: "unknown",
                }),
        },
    });
    runtime.session.subscribe((event) => events.push(event));
    await planStream(runtime.session, [
        [{ name: "write", args: { path: target, content: "must not escape" } }],
        [
            {
                name: "write",
                args: { path: target, content: "must still not escape" },
            },
        ],
    ]);
    const stream = runtime.session.agent.streamFunction;
    runtime.session.agent.streamFunction = (...args) => {
        requests.push(structuredClone(args[1].messages));
        return stream(...args);
    };
    await runtime.session.prompt(
        "Check malformed review output against the owned sentinel.",
    );
    expect(reviews).toBe(2);
    expect(await readFile(target, "utf8")).toBe("unchanged");
    const results = events.filter(
        (event) => event.type === "tool_execution_end",
    );
    expect(results.length).toBe(2);
    expect(
        results.every(
            (event) =>
                event.isError &&
                JSON.stringify(event.result).includes("AUTO_REVIEW_FAILED"),
        ),
    ).toBeTruthy();
    expect(requests.length).toBe(3);
    expect(
        requests[1].some(
            (message) =>
                message.role === "toolResult" &&
                JSON.stringify(message).includes("AUTO_REVIEW_FAILED"),
        ),
    ).toBeTruthy();
    const audit = (
        await readFile(join(f.agentDir, "guard/audit.jsonl"), "utf8")
    )
        .trim()
        .split("\n")
        .map(JSON.parse);
    expect(audit.filter((row) => row.review?.status === "failed").length).toBe(
        2,
    );
    expect(audit.some((row) => row.outcome === "approved")).toBeFalsy();
});
test("[workflow] quoted review rationale is redacted without breaking approved execution or JSON audit", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt"),
        secret = "quoted-fixture-private-value";
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async () =>
                JSON.stringify({
                    outcome: "allow",
                    risk_level: "low",
                    user_authorization: "high",
                    rationale: `Owned file; token="${secret}" is not logged.`,
                }),
        },
    });
    await planStream(runtime.session, [
        [{ name: "write", args: { path: target, content: "approved" } }],
    ]);
    await runtime.session.prompt("Update only the owned sentinel.");
    expect(await readFile(target, "utf8")).toBe("approved");
    const text = await readFile(join(f.agentDir, "guard/audit.jsonl"), "utf8"),
        rows = text.trim().split("\n").map(JSON.parse);
    expect(rows.some((row) => row.review?.status === "approved")).toBeTruthy();
    expect(text.includes(secret)).toBeFalsy();
    expect(
        rows.some(
            (row) => row.event === "execution" && row.outcome === "settled",
        ),
    ).toBeTruthy();
});
test("[workflow] denial circuit stops the model but a later direct user shell has its own cancellation lifetime", async (t) => {
    const f = await fixture(t),
        events = [];
    let reviews = 0;
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async () => {
                reviews++;
                return '{"outcome":"deny","rationale":"Owned denial-limit scenario"}';
            },
        },
    });
    runtime.session.subscribe((event) => events.push(event));
    await planStream(
        runtime.session,
        Array.from({ length: 4 }, (_, index) => [
            {
                name: "write",
                args: {
                    path: join(f.outside, `denied-${index}.txt`),
                    content: "blocked",
                },
            },
        ]),
    );
    await runtime.session.prompt("Exercise denial limits with owned targets.");
    expect(reviews).toBe(3);
    for (let index = 0; index < 4; index++)
        await expect(
            access(join(f.outside, `denied-${index}.txt`)),
        ).rejects.toThrow();
    const result = await runtime.session.executeBash(
        "printf direct-user-after-denial",
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("direct-user-after-denial");
    const results = events.filter(
        (event) => event.type === "tool_execution_end",
    );
    expect(results.every((event) => event.isError)).toBeTruthy();
    expect(
        results.filter((event) =>
            JSON.stringify(event.result).includes("AUTO_REVIEW_DENIED"),
        ).length,
    ).toBe(3);
});
test("[workflow] trusted project MCP configuration cannot be rewritten by model tools or interpreters before reload", async (t) => {
    const f = await fixture(t),
        directory = join(f.workspace, ".pi"),
        path = join(directory, "mcp.json"),
        target = join(f.outside, "sentinel.txt");
    await mkdir(directory);
    await writeFile(path, '{"mcpServers":{}}');
    const injected = JSON.stringify({
        mcpServers: {
            injected: {
                command: process.execPath,
                args: [
                    join(repository, "tests/harness/mcp-server.mjs"),
                    target,
                    "startup-effect",
                ],
                exposure: "direct",
            },
        },
    });
    let reviews = 0;
    const runtime = await guardedFixture(t, f, {
        settingsManager: undefined,
        isProjectTrusted: true,
        provider: {
            complete: async () => {
                reviews++;
                return '{"outcome":"deny","rationale":"Do not modify control files through an interpreter"}';
            },
        },
    });
    await planStream(runtime.session, [
        [{ name: "write", args: { path, content: injected } }],
        [
            {
                name: "bash",
                args: {
                    command: `${shellQuote(process.execPath)} -e ${shellQuote(`require('fs').writeFileSync(${JSON.stringify(path)},${JSON.stringify(injected)})`)}`,
                },
            },
        ],
    ]);
    await runtime.session.prompt("Keep project control files unchanged.");
    await runtime.session.reload();
    await planStream(runtime.session, []);
    await runtime.session.prompt(
        "Wait for configured MCP startup after reload.",
    );
    expect(await readFile(target, "utf8")).toBe("unchanged");
    expect(await readFile(path, "utf8")).toBe('{"mcpServers":{}}');
    expect(reviews).toBe(2);
    await rm(directory, { recursive: true });
    await runtime.session.reload();
    const createConfig = `const fs=require('fs');fs.mkdirSync(${JSON.stringify(directory)},{recursive:true});fs.writeFileSync(${JSON.stringify(path)},${JSON.stringify(injected)});`;
    await planStream(runtime.session, [
        [{ name: "write", args: { path, content: injected } }],
        [
            {
                name: "bash",
                args: {
                    command: `${shellQuote(process.execPath)} -e ${shellQuote(createConfig)}`,
                },
            },
        ],
    ]);
    await runtime.session.prompt(
        "Do not create missing project execution configuration.",
    );
    await runtime.session.reload();
    await planStream(runtime.session, []);
    await runtime.session.prompt(
        "Check startup after refused configuration creation.",
    );
    expect(await readFile(target, "utf8")).toBe("unchanged");
    await expect(access(path)).rejects.toThrow();
    await mkdir(directory, { recursive: true });
    await writeFile(path, injected);
    await runtime.session.reload();
    await planStream(runtime.session, []);
    await runtime.session.prompt(
        "Load the explicitly edited MCP configuration.",
    );
    expect(
        await readFile(target, "utf8"),
        "An explicit host-side configuration update still loads",
    ).toBe("started-by-project-config");
});
test("[workflow] trusted extension entrypoint and sibling modules cannot be replaced before reload", async (t) => {
    const f = await fixture(t),
        directory = join(f.workspace, "owned-provider"),
        entry = join(directory, "index.mjs"),
        helper = join(directory, "helper.mjs"),
        target = join(f.outside, "sentinel.txt");
    await mkdir(directory);
    await writeFile(helper, 'export const value="trusted";');
    const original =
        'import {value} from "./helper.mjs"; export default api=>{if(value!=="trusted")throw new Error("Changed trusted module");};';
    await writeFile(entry, original);
    const runtime = await guardedFixture(t, f, {
        trustedExtensionPaths: [entry],
        provider: {
            complete: () =>
                expect.unreachable(
                    "Trusted code mutation must not reach approval",
                ),
        },
    });
    const injected = `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(target)},"unreviewed-controller-effect");export default ()=>{};`;
    await planStream(runtime.session, [
        [{ name: "write", args: { path: entry, content: injected } }],
        [
            {
                name: "write",
                args: {
                    path: helper,
                    content: 'export const value="changed";',
                },
            },
        ],
    ]);
    await runtime.session.prompt("Do not replace trusted provider code.");
    await runtime.session.reload();
    expect(await readFile(target, "utf8")).toBe("unchanged");
    expect(await readFile(entry, "utf8")).toBe(original);
    expect(await readFile(helper, "utf8")).toBe(
        'export const value="trusted";',
    );
});
test("[workflow] real MCP node_repl/js follows explicit prompt approval and never acquires Computer Use privileges", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt"),
        processLog = join(f.root, "mcp-processes.jsonl");
    const runtime = await guardedFixture(t, f, {
        settings: { approvalsReviewer: "user" },
        mcpToolPolicies: { "node_repl/js": { approvalMode: "prompt" } },
        mcp: {
            loadConfig: () => ({
                servers: [
                    {
                        name: "node_repl",
                        config: {
                            command: process.execPath,
                            args: [
                                join(repository, "tests/harness/mcp-server.mjs"),
                                target,
                                "no-startup-effect",
                                "js",
                                processLog,
                            ],
                            exposure: "direct",
                        },
                        source: "owned-name-collision",
                        scope: "extension",
                    },
                ],
                errors: [],
            }),
        },
        provider: {
            complete: () =>
                expect.unreachable("User review cannot call the model"),
        },
    });
    const invoke = async (value) => {
        await planStream(runtime.session, [
            [{ name: "mcp__node_repl__js", args: { value } }],
        ]);
        await runtime.session.prompt(
            "Use the owned MCP fixture only after approval.",
        );
    };
    await invoke("no-ui");
    expect(await readFile(target, "utf8")).toBe("unchanged");
    let prompts = 0;
    await runtime.session.bindExtensions({
        mode: "rpc",
        uiContext: {
            select: async (_title, choices) => {
                prompts++;
                return prompts === 1 ? choices.at(-1) : choices[0];
            },
            notify() {},
            setStatus() {},
            setWidget() {},
        },
    });
    await invoke("denied");
    expect(await readFile(target, "utf8")).toBe("unchanged");
    await invoke("approved");
    expect(await readFile(target, "utf8")).toBe("approved");
    expect(prompts).toBe(2);
    await runtime.dispose();
    const processes = (await readFile(processLog, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
    expect(processes.length).toBe(2);
    for (const { pid } of processes)
        expect(() => process.kill(pid, 0)).toThrow(
            expect.toSatisfy((error) => error.code === "ESRCH"),
        );
});
test("[workflow] literal metacharacters remain exact review evidence and owned filenames stay usable", async (t) => {
    const f = await fixture(t),
        literal = join(f.outside, "literal-[ab]"),
        sibling = join(f.outside, "literal-a"),
        events = [];
    let reviews = 0;
    await writeFile(literal, "literal-original");
    await writeFile(sibling, "sibling-original");
    const runtime = await guardedFixture(t, f, {
        provider: {
            complete: async (request) => {
                reviews++;
                expect(
                    JSON.parse(request.data).requestedPermissionDelta
                        .writePaths,
                ).toStrictEqual([literal]);
                return '{"outcome":"deny","risk_level":"low","user_authorization":"high"}';
            },
        },
    });
    runtime.session.subscribe((event) => events.push(event));
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(`require('fs').writeFileSync(${JSON.stringify(sibling)},"escaped-through-pattern")`)}`;
    await planStream(runtime.session, [
        [
            {
                name: "bash",
                args: {
                    command,
                    sandbox_permissions: "require_escalated",
                    additional_permissions: { writePaths: [literal] },
                },
            },
        ],
        [
            {
                name: "write",
                args: {
                    path: "[route]/literal-*.txt",
                    content: "literal-workspace-effect",
                },
            },
        ],
    ]);
    await runtime.session.prompt(
        "Use only literal path permissions for the owned fixture.",
    );
    expect(await readFile(literal, "utf8")).toBe("literal-original");
    expect(await readFile(sibling, "utf8")).toBe("sibling-original");
    expect(reviews).toBe(1);
    expect(
        await readFile(join(f.workspace, "[route]/literal-*.txt"), "utf8"),
    ).toBe("literal-workspace-effect");
    const results = events.filter(
        (event) => event.type === "tool_execution_end",
    );
    expect(results.length).toBe(2);
    expect(results[0].isError).toBe(true);
    expect(results[1].isError).toBe(false);
    expect(
        JSON.stringify(results[0].result).includes("AUTO_REVIEW_DENIED"),
    ).toBeTruthy();
});
test("[workflow] real CLI loads an explicit provider and selects the same model for execution and review", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt"),
        trace = join(f.control, "provider-calls.jsonl"),
        config = join(f.control, "cli-fixture.json"),
        policy = join(f.agentDir, "policy.json"),
        home = join(f.control, "home");
    await mkdir(home);
    await writeFile(config, JSON.stringify({ target, trace }));
    await writeFile(
        policy,
        JSON.stringify({
            excludeSlashTmp: true,
            excludeTmpdir: true,
            reviewMaxOutputTokens: 777,
        }),
    );
    const env = {
        ...workloadEnvironment(),
        HOME: home,
        PI_CODING_AGENT_DIR: f.agentDir,
        PI_GUARD_CLI_FIXTURE: config,
        ...(process.env.PI_GUARD_KERNEL_ARCH
            ? { PI_GUARD_KERNEL_ARCH: process.env.PI_GUARD_KERNEL_ARCH }
            : {}),
    };
    const args = [
        join(repository, "dist/cli.js"),
        "--cwd",
        f.workspace,
        "--policy",
        policy,
        "--extension",
        "tests/harness/cli-provider.mjs",
        "--provider",
        "owned-cli",
        "--model",
        "owned-model",
        "--mode",
        "json",
        "Update only the explicitly owned CLI sentinel.",
    ];
    const result = await exec(process.execPath, args, {
        cwd: repository,
        env,
        timeout: 60000,
        maxBuffer: 2_000_000,
    });
    const diagnostic = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line))
        .filter(
            (event) =>
                event.type === "tool_execution_end" ||
                (event.type === "message_end" && event.message?.errorMessage),
        );
    expect(
        await readFile(target, "utf8"),
        `${JSON.stringify(diagnostic)}\n${result.stderr}`,
    ).toBe("cli-approved-effect");
    const calls = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
    expect(calls.map((call) => call.isReview)).toStrictEqual([
        false,
        true,
        false,
    ]);
    expect(calls[1].maxTokens).toBe(777);
    expect(
        calls.every(
            (call) =>
                call.provider === "owned-cli" && call.model === "owned-model",
        ),
    ).toBeTruthy();
    expect(result.stdout).toMatch(/owned-cli-complete/);
    const audit = (
        await readFile(join(f.agentDir, "guard/audit.jsonl"), "utf8")
    )
        .trim()
        .split("\n")
        .map(JSON.parse);
    expect(audit.some((row) => row.review?.status === "approved")).toBeTruthy();
    expect(
        audit.some(
            (row) => row.event === "execution" && row.outcome === "settled",
        ),
    ).toBeTruthy();
    await expect(
        exec(
            process.execPath,
            [...args.slice(0, -1), "--model", "missing-model", "Do not run."],
            { cwd: repository, env, timeout: 60000, maxBuffer: 2_000_000 },
        ),
    ).rejects.toThrow(
        expect.toSatisfy(
            (error) =>
                error.code === 1 &&
                error.stderr.includes("Registered model not found"),
        ),
    );
    expect(
        (await readFile(trace, "utf8")).trim().split("\n").length,
        "An unavailable selection must not call another model",
    ).toBe(3);
});
test("[workflow] live CLI observer counts actual HTTP main and reviewer calls without replacing provider responses", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt"),
        trace = join(f.agentDir, "calls.jsonl"),
        requests = [];
    let mainCalls = 0,
        reviewCalls = 0,
        serverError;
    const server = createServer(async (request, response) => {
        try {
            let body = "";
            for await (const chunk of request) body += chunk;
            const payload = JSON.parse(body),
                isReview = payload.messages.some(
                    (message) =>
                        message.role === "system" &&
                        JSON.stringify(message).includes("# Outcome Policy"),
                );
            if (isReview) reviewCalls++;
            else mainCalls++;
            expect(
                mainCalls <= 2 && reviewCalls <= 1,
                "Unexpected extra HTTP model request",
            ).toBeTruthy();
            requests.push({
                isReview,
                maxTokens: payload.max_tokens ?? payload.max_completion_tokens,
            });
            const delta = isReview
                ? {
                      content:
                          '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"Owned HTTP fixture"}',
                  }
                : mainCalls === 1
                  ? {
                        tool_calls: [
                            {
                                index: 0,
                                id: "owned-http-write",
                                type: "function",
                                function: {
                                    name: "write",
                                    arguments: JSON.stringify({
                                        path: target,
                                        content: "http-observed-effect",
                                    }),
                                },
                            },
                        ],
                    }
                  : { content: "owned-http-complete" };
            response.writeHead(200, { "content-type": "text/event-stream" });
            for (const [content, finish] of [
                [{ role: "assistant", ...delta }, null],
                [{}, delta.tool_calls ? "tool_calls" : "stop"],
            ]) {
                response.write(
                    "data: " +
                        JSON.stringify({
                            id: `owned-${requests.length}`,
                            object: "chat.completion.chunk",
                            created: 1,
                            model: "glm-5.3",
                            choices: [
                                {
                                    index: 0,
                                    delta: content,
                                    finish_reason: finish,
                                },
                            ],
                        }) +
                        "\n\n",
                );
            }
            response.end("data: [DONE]\n\n");
        } catch (error) {
            serverError = error;
            response.writeHead(500);
            response.end("Owned fixture error");
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.onTestFinished(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    const providerDirectory = join(f.control, "provider"),
        home = join(f.control, "home");
    await Promise.all([providerDirectory, home].map((path) => mkdir(path)));
    const extension = join(providerDirectory, "index.mjs"),
        policy = join(f.agentDir, "policy.json");
    const provider = {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        api: "openai-completions",
        apiKey: "owned-observer-key",
        models: [
            {
                id: "glm-5.3",
                name: "Owned HTTP model",
                reasoning: false,
                input: ["text"],
                contextWindow: 100000,
                maxTokens: 10000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
        ],
    };
    await writeFile(
        extension,
        `export default api=>api.registerProvider('ollama-cloud',${JSON.stringify(provider)});`,
    );
    await writeFile(
        policy,
        JSON.stringify({
            excludeSlashTmp: true,
            excludeTmpdir: true,
            reviewMaxOutputTokens: 777,
        }),
    );
    await writeFile(
        join(f.agentDir, "settings.json"),
        JSON.stringify({
            cacheWarming: "off",
            compaction: { enabled: false },
            retry: { enabled: false, provider: { maxRetries: 0 } },
        }),
    );
    const env = {
        ...workloadEnvironment(),
        HOME: home,
        PI_CODING_AGENT_DIR: f.agentDir,
        OLLAMA_API_KEY: "owned-observer-key",
        OLLAMA_MODEL: "glm-5.3",
        PI_GUARD_CLI_TRACE: trace,
        ...(process.env.PI_GUARD_KERNEL_ARCH
            ? { PI_GUARD_KERNEL_ARCH: process.env.PI_GUARD_KERNEL_ARCH }
            : {}),
    };
    const child = await exec(
        process.execPath,
        [
            join(repository, "dist/cli.js"),
            "--cwd",
            f.workspace,
            "--policy",
            policy,
            "--extension",
            extension,
            "--extension",
            join(repository, "tests/harness/cli-observer.mjs"),
            "--provider",
            "ollama-cloud",
            "--model",
            "glm-5.3",
            "--mode",
            "json",
            "Update the owned HTTP sentinel.",
        ],
        { cwd: repository, env, timeout: 60000, maxBuffer: 2_000_000 },
    );
    expect(serverError).toBe(undefined);
    expect(await readFile(target, "utf8")).toBe("http-observed-effect");
    const calls = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
    expect(calls.map((call) => call.isReview)).toStrictEqual([
        false,
        true,
        false,
    ]);
    expect(requests.map((request) => request.isReview)).toStrictEqual([
        false,
        true,
        false,
    ]);
    expect(requests[1].maxTokens).toBe(777);
    expect(
        requests
            .filter((request) => !request.isReview)
            .every(
                (request) =>
                    Number.isInteger(request.maxTokens) &&
                    request.maxTokens > 0 &&
                    request.maxTokens <= 4096,
            ),
    ).toBeTruthy();
    expect(child.stdout).toMatch(/owned-http-complete/);
    expect(child.stdout.includes(env.OLLAMA_API_KEY)).toBeFalsy();
});
test("[workflow] trusted Pi skills prompts and themes reach the session while project trust and extension isolation remain effective", async (t) => {
    const f = await fixture(t),
        globalSkill = join(f.agentDir, "skills", "owned-global"),
        project = join(f.workspace, ".pi");
    await Promise.all(
        [
            globalSkill,
            join(project, "skills", "owned-project"),
            join(project, "prompts"),
            join(project, "themes"),
            join(project, "extensions"),
        ].map((path) => mkdir(path, { recursive: true })),
    );
    await writeFile(
        join(globalSkill, "SKILL.md"),
        "---\nname: owned-global\ndescription: Owned global skill\n---\nGlobal fixture instructions.\n",
    );
    await writeFile(
        join(project, "skills/owned-project/SKILL.md"),
        "---\nname: owned-project\ndescription: Owned trusted project skill\n---\nProject fixture instructions.\n",
    );
    await writeFile(
        join(project, "prompts/owned-prompt.md"),
        "---\ndescription: Owned prompt\n---\nOwned expanded prompt $ARGUMENTS",
    );
    const theme = JSON.parse(
        await readFile(
            new URL(
                "./modes/interactive/theme/light.json",
                import.meta.resolve("@earendil-works/pi-coding-agent"),
            ),
            "utf8",
        ),
    );
    theme.name = "owned-theme";
    await writeFile(
        join(project, "themes/owned-theme.json"),
        JSON.stringify(theme),
    );
    await writeFile(
        join(project, "extensions/untrusted.mjs"),
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(f.outside, "sentinel.txt"))},'unwanted-extension');export default ()=>{};`,
    );
    const trusted = await guardedFixture(t, f, {
            settingsManager: undefined,
            isProjectTrusted: true,
        }),
        loader = trusted.services.resourceLoader;
    expect(
        loader
            .getSkills()
            .skills.some((skill) => skill.name === "owned-global"),
    ).toBeTruthy();
    expect(
        loader
            .getSkills()
            .skills.some((skill) => skill.name === "owned-project"),
    ).toBeTruthy();
    expect(
        loader
            .getPrompts()
            .prompts.some((prompt) => prompt.name === "owned-prompt"),
    ).toBeTruthy();
    expect(
        loader.getThemes().themes.some((theme) => theme.name === "owned-theme"),
    ).toBeTruthy();
    const requests = [];
    await planStream(trusted.session, []);
    const stream = trusted.session.agent.streamFunction;
    trusted.session.agent.streamFunction = (...args) => {
        requests.push(structuredClone(args[1]));
        return stream(...args);
    };
    await trusted.session.prompt("/owned-prompt final-consumer", {
        expandPromptTemplates: true,
    });
    expect(
        JSON.stringify(requests[0]).includes("owned-project"),
        JSON.stringify({ keys: Object.keys(requests[0]) }),
    ).toBeTruthy();
    expect(
        JSON.stringify(requests[0].messages).includes(
            "Owned expanded prompt final-consumer",
        ),
    ).toBeTruthy();
    expect(await readFile(join(f.outside, "sentinel.txt"), "utf8")).toBe(
        "unchanged",
    );
    const untrusted = await guardedFixture(t, f, {
            settingsManager: undefined,
            isProjectTrusted: false,
        }),
        untrustedLoader = untrusted.services.resourceLoader;
    expect(
        untrustedLoader
            .getSkills()
            .skills.some((skill) => skill.name === "owned-global"),
    ).toBeTruthy();
    expect(
        untrustedLoader
            .getSkills()
            .skills.some((skill) => skill.name === "owned-project"),
    ).toBeFalsy();
    expect(
        untrustedLoader
            .getPrompts()
            .prompts.some((prompt) => prompt.name === "owned-prompt"),
    ).toBeFalsy();
    expect(
        untrustedLoader
            .getThemes()
            .themes.some((theme) => theme.name === "owned-theme"),
    ).toBeFalsy();
});
test("[package] npm tarball loads the default factory through public Pi APIs without bundled sandbox assets", async (t) => {
    const f = await fixture(t),
        artifacts = join(f.root, "artifacts"),
        consumer = join(f.agentDir, "npm/consumer # fixture"),
        home = join(f.control, "fake-home");
    await Promise.all(
        [artifacts, consumer, home].map((path) =>
            mkdir(path, { recursive: true }),
        ),
    );
    const env = {
        ...workloadEnvironment(),
        ...(process.env.PI_GUARD_KERNEL_ARCH
            ? { PI_GUARD_KERNEL_ARCH: process.env.PI_GUARD_KERNEL_ARCH }
            : {}),
        PI_CODING_AGENT_DIR: f.agentDir,
        NPM_CONFIG_CACHE: join(f.control, "npm-cache"),
        NPM_CONFIG_USERCONFIG: join(f.control, "empty.npmrc"),
        NPM_CONFIG_GLOBALCONFIG: join(f.control, "global.npmrc"),
    };
    const packed = JSON.parse(
        (
            await exec(
                "npm",
                [
                    "pack",
                    "--ignore-scripts",
                    "--json",
                    "--pack-destination",
                    artifacts,
                ],
                { cwd: repository, env, timeout: 20000, maxBuffer: 2_000_000 },
            )
        ).stdout,
    )[0];
    expect(
        packed.files.some((file) => file.path === "dist/tools/executor.js"),
    ).toBeTruthy();
    expect(
        packed.files.some((file) => file.path === "dist/approval-commands.js"),
    ).toBeTruthy();
    expect(
        packed.files.some(
            (file) =>
                file.path.startsWith("dist/sandbox/") ||
                file.path.startsWith("node_modules/"),
        ),
    ).toBeFalsy();
    expect(
        packed.files.some(
            (file) => file.path === "dist/policy/rules-worker.js",
        ),
    ).toBeTruthy();
    expect(
        packed.files.some(
            (file) =>
                file.path.startsWith("dist/native/") ||
                file.path.endsWith(".node"),
        ),
    ).toBeFalsy();
    expect(
        packed.files.some(
            (file) =>
                /^(src|test|tmp|vendor)\//.test(file.path) ||
                /^node_modules\/@earendil-works\//.test(file.path),
        ),
    ).toBeFalsy();
    await exec(
        "tar",
        ["-xzf", join(artifacts, packed.filename), "-C", consumer],
        { timeout: 10000 },
    );
    await mkdir(join(consumer, "package/node_modules"), { recursive: true });
    // Install the runtime dependency from its own packed artifact, as npm would.
    const redactPacked = JSON.parse(
            (
                await exec(
                    "npm",
                    [
                        "pack",
                        "--ignore-scripts",
                        "--json",
                        "--pack-destination",
                        artifacts,
                    ],
                    {
                        cwd: join(repository, "../../packages/redact"),
                        env,
                        timeout: 20000,
                        maxBuffer: 2_000_000,
                    },
                )
            ).stdout,
        )[0],
        redactDirectory = join(consumer, "package/node_modules/@buyong/redact");
    expect(
        redactPacked.files.some(
            (file) => file.path === "dist/pii/data/catalog.js",
        ) && redactPacked.files.some((file) => file.path === "NOTICE"),
    ).toBeTruthy();
    await mkdir(redactDirectory, { recursive: true });
    await exec(
        "tar",
        [
            "-xzf",
            join(artifacts, redactPacked.filename),
            "-C",
            redactDirectory,
            "--strip-components=1",
        ],
        { timeout: 10000 },
    );
    await writeFile(
        join(f.agentDir, "mcp.json"),
        JSON.stringify({
            mcpServers: {
                stdio: {
                    command: process.execPath,
                    args: [
                        join(repository, "tests/harness/mcp-server.mjs"),
                        join(f.outside, "sentinel.txt"),
                        "no-startup-effect",
                        "read_owned",
                    ],
                    exposure: "direct",
                },
            },
        }),
    );
    const script = join(consumer, "package/probe.mjs");
    await writeFile(
        script,
        `
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAgentSessionRuntime,createAgentSessionServices,createAgentSessionFromServices,createMcpExtension,SettingsManager,SessionManager,VERSION} from ${JSON.stringify(process.env.PI_GUARD_TEST_HOST_SDK_ENTRY ?? import.meta.resolve("@earendil-works/pi-coding-agent"))};
import {offlineModelRuntime,planStream,FAKE_MODEL} from ${JSON.stringify(new URL("../harness/pi.mjs", import.meta.url).href)};
import {parseRules,evaluateRules} from './dist/policy/rules.js';
assert.equal(parseRules('prefix_rule(pattern=["packed"], decision="forbidden")')[0].decision,'forbidden');
assert.equal((await evaluateRules([{name:'packed.rules',source:'prefix_rule(["packed"], decision="prompt")'}],[['packed','--check']])).matches[0][0].decision,'prompt');
const cwd=process.cwd(),agentDir=process.env.GUARD_AGENT_DIR;
const modelRuntime=await offlineModelRuntime({agentDir});
const runtime=await createAgentSessionRuntime(async input=>{
 const services=await createAgentSessionServices({...input,modelRuntime,settingsManager:SettingsManager.inMemory({cacheWarming:'off',compaction:{enabled:false}}),resourceLoaderOptions:{additionalExtensionPaths:[${JSON.stringify(join(consumer, "package/dist/index.js"))}],extensionFactories:[{name:'mcp',factory:createMcpExtension(),replaceable:true}],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true}});
 assert.equal(services.resourceLoader.getExtensions().errors.length,0);
 const result=await createAgentSessionFromServices({services,sessionManager:input.sessionManager,model:FAKE_MODEL});
 await result.session.bindExtensions({mode:'print'});
 return {...result,services};
},{cwd,agentDir,sessionManager:SessionManager.inMemory(cwd)});
try {
 const events=[];runtime.session.subscribe(event=>events.push(event));
 await planStream(runtime.session,[[{name:'write',args:{path:'packed.txt',content:'packed-effect'}}],[{name:'mcp__stdio__read_owned',args:{value:'owned'}}]]);
 await runtime.session.prompt('Write the owned local file and read the owned MCP sentinel.');
 assert.equal(await readFile('packed.txt','utf8'),'packed-effect');
 const results=events.filter(event=>event.type==='tool_execution_end');
 assert.equal(results.length,2);assert.ok(results.every(event=>!event.isError),JSON.stringify(results));
 assert.ok(JSON.stringify(results[1].result).includes('unchanged'));
 assert.equal(runtime.services.resourceLoader.getExtensions().extensions.filter(extension=>extension.commands.has('mcp')).length,1);
 console.log(JSON.stringify({factoryLoaded:true,workerEffect:true,officialMcp:true,hostVersion:VERSION}));
} finally {await runtime.dispose();}
`,
    );
    const started = Date.now();
    const executed = await exec(process.execPath, [script], {
        cwd: f.workspace,
        env: { ...env, GUARD_AGENT_DIR: f.agentDir },
        timeout: 60000,
        maxBuffer: 2000000,
    }).catch((error) => {
        throw new Error(
            `Packed probe failed after ${Date.now() - started}ms; code=${error.code}; killed=${error.killed}; signal=${error.signal}; stderr=${error.stderr ?? ""}`,
            { cause: error },
        );
    });
    expect(executed.stdout).toMatch(/"factoryLoaded":true/);
    expect(executed.stdout).toMatch(/"officialMcp":true/);
    expect(await readFile(join(f.workspace, "packed.txt"), "utf8")).toBe(
        "packed-effect",
    );
    await symlink(
        join(repository, "node_modules/@earendil-works"),
        join(consumer, "package/node_modules/@earendil-works"),
    );
    const help = await exec(
        process.execPath,
        [join(consumer, "package/dist/cli.js"), "--help"],
        { cwd: f.workspace, env, timeout: 10000 },
    );
    expect(help.stdout).toMatch(/^Usage: pi-codex-auto-review /);
    expect(help.stdout).not.toMatch(/[가-힣]/);
});
test("[cleanup] nonempty owned audit population is scanned and native resources settle before disposal", async (t) => {
    const population = await readFile(auditPopulationPath, "utf8");
    expect(population.trim().split("\n").length > 0).toBeTruthy();
    expect(/SYNTHETIC_GUARD_SECRET_[a-z0-9-]+/i.test(population)).toBeFalsy();
    const f = await fixture(t),
        executor = new PiExecutor();
    await executor.execute(
        {
            kind: "file",
            operation: "write",
            path: join(f.workspace, "cleanup.txt"),
            content: "done",
            cwd: f.workspace,
        },
        f.profile,
        EMPTY_DELTA,
    );
    await executor.close();
    await expect(
        executor.execute(
            { kind: "shell", command: "printf no", cwd: f.workspace },
            f.profile,
            EMPTY_DELTA,
        ),
    ).rejects.toThrow();
    expect(executor.activeInvocationCount).toBe(0);
    expect(await readFile(join(f.workspace, "cleanup.txt"), "utf8")).toBe(
        "done",
    );
});
