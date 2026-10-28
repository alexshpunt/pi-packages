import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import {
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createMcpExtension,
    ProjectTrustStore,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createGuardExtension } from "../../dist/index.js";
import { fixture } from "../harness/fixtures.mjs";
import {
    FixtureMcpTransport,
    mcpFixture,
    mcpText,
    toolMetaFixture,
} from "../harness/mcp.mjs";
import {
    FAKE_MODEL,
    guardedFixture,
    offlineModelRuntime,
    planStream,
} from "../harness/pi.mjs";

const schema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
};
const tool = (name, extra = {}) => ({
    name,
    description: `Owned ${name} tool`,
    inputSchema: schema,
    ...extra,
});
const allowed =
    '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"Owned fixture"}';
async function invoke(runtime, name, value = "owned") {
    await planStream(runtime.session, [[{ name, args: { value } }]]);
    await runtime.session.prompt("Use only the owned MCP fixture.");
}
test("[external-tools] an ordinary installation leaves MCP to Pi's extension and reviews its calls before they run", async (t) => {
    const f = await fixture(t),
        reviews = [];
    const transport = new FixtureMcpTransport([tool("write")], async (params) =>
        mcpText(params.arguments.value),
    );
    const guard = createGuardExtension({
        cwd: f.workspace,
        agentDir: f.agentDir,
        profile: f.profile,
        provider: {
            complete: async (request) => {
                reviews.push(JSON.parse(request.data));
                return reviews.length === 1
                    ? '{"outcome":"deny","rationale":"No effect authorized"}'
                    : allowed;
            },
        },
    });
    const modelRuntime = await offlineModelRuntime(f);
    const runtime = await createAgentSessionRuntime(
        async (input) => {
            const services = await createAgentSessionServices({
                ...input,
                modelRuntime,
                settingsManager: SettingsManager.inMemory({
                    cacheWarming: "off",
                    compaction: { enabled: false },
                    quietStartup: true,
                }),
                resourceLoaderOptions: {
                    extensionFactories: [
                        guard.factory,
                        {
                            name: "mcp",
                            factory: createMcpExtension(
                                mcpFixture("owned", transport),
                            ),
                        },
                    ],
                    noExtensions: true,
                    noContextFiles: true,
                    noSkills: true,
                    noPromptTemplates: true,
                    noThemes: true,
                },
            });
            const result = await createAgentSessionFromServices({
                services,
                sessionManager: input.sessionManager,
                model: FAKE_MODEL,
            });
            await result.session.bindExtensions({ mode: "print" });
            return { ...result, services };
        },
        {
            cwd: f.workspace,
            agentDir: f.agentDir,
            sessionManager: SessionManager.inMemory(f.workspace),
        },
    );
    t.onTestFinished(() => runtime.dispose());
    expect(
        runtime.services.resourceLoader
            .getExtensions()
            .extensions.filter((extension) => extension.commands.has("mcp")),
    ).toHaveLength(1);
    await invoke(runtime, "mcp__owned__write", "denied");
    expect(transport.calls).toHaveLength(0);
    await invoke(runtime, "mcp__owned__write", "approved");
    expect(transport.calls.map((call) => call.params.arguments.value)).toStrictEqual(["approved"]);
    expect(reviews.map((review) => review.untrustedAction.args.arguments.value)).toStrictEqual(["denied", "approved"]);
    expect(reviews[0].untrustedAction.args.externalTool).toMatchObject({
        kind: "mcp",
        server: "owned",
        tool: "write",
    });
});
test("[external-tools] strict MCP tools are reviewed on every call despite read-only hints", async (t) => {
    const f = await fixture(t),
        reviews = [],
        effects = [],
        tools = [
            tool("inspect", {
                annotations: { readOnlyHint: true },
                _meta: { codex_strict_auto_review: true },
            }),
        ],
        transport = new FixtureMcpTransport(tools, async (params) => {
            effects.push(params.arguments.value);
            return mcpText(params.arguments.value);
        });
    const runtime = await guardedFixture(t, f, {
        mcp: mcpFixture("owned", transport),
        provider: {
            complete: async (request) => {
                reviews.push(JSON.parse(request.data));
                return allowed;
            },
        },
        trustedExtensions: [toolMetaFixture("owned", tools)],
    });
    const events = [];
    runtime.session.subscribe((event) => events.push(event));
    await invoke(runtime, "mcp__owned__inspect");
    await invoke(runtime, "mcp__owned__inspect");
    expect(effects).toStrictEqual(["owned", "owned"]);
    expect(reviews.length).toBe(2);
    expect(reviews[0].untrustedAction.args.arguments.value).toBe("owned");
    expect(reviews[0].untrustedAction.args.externalTool.server).toBe("owned");
    expect(
        events
            .filter((event) => event.type === "tool_execution_end")
            .every((event) => !event.isError),
    ).toBeTruthy();
});
test("[external-tools] connected-account evidence is copied only from the explicit registered MCP metadata field", async (t) => {
    const f = await fixture(t),
        requests = [];
    const tools = [
        tool("identified", {
            _meta: {
                connected_account_email: "verified@example.test",
                account: "legacy-account",
            },
        }),
        tool("unknown", { _meta: { account: "unverified@example.test" } }),
    ];
    const transport = new FixtureMcpTransport(tools, () =>
        expect.unreachable("Denied account fixture executed"),
    );
    const runtime = await guardedFixture(t, f, {
        mcp: mcpFixture("owned", transport),
        provider: {
            complete: async (request) => {
                requests.push(JSON.parse(request.data));
                return '{"outcome":"deny"}';
            },
        },
        trustedExtensions: [toolMetaFixture("owned", tools)],
    });
    await invoke(runtime, "mcp__owned__identified");
    await invoke(runtime, "mcp__owned__unknown");
    expect(requests[0].untrustedAction.args.connected_account_email).toBe(
        "verified@example.test",
    );
    expect(requests[1].untrustedAction.args.connected_account_email).toBe(
        undefined,
    );
    expect(requests[1].untrustedAction.args.externalTool.account).toBe(
        "unverified@example.test",
    );
});
test("[external-tools] MCP denial, required human input and granular policy prevent effects", async (t) => {
    const f = await fixture(t);
    for (const [extra, settings] of [
        [{}, {}],
        [{ _meta: { codex_requires_user_input: true } }, {}],
        [
            {},
            {
                approvalPolicy: {
                    sandbox: true,
                    rules: true,
                    mcp_elicitations: false,
                },
            },
        ],
    ]) {
        let reviews = 0;
        const tools = [tool("write", extra)];
        const transport = new FixtureMcpTransport(tools, async () =>
            expect.unreachable("Denied MCP tool executed"),
        );
        const runtime = await guardedFixture(t, f, {
            mcp: mcpFixture("owned", transport),
            settings,
            provider: {
                complete: async () => {
                    reviews++;
                    return '{"outcome":"deny","rationale":"No effect authorized"}';
                },
            },
            trustedExtensions: [toolMetaFixture("owned", tools)],
        });
        await invoke(runtime, "mcp__owned__write");
        expect(transport.calls.length).toBe(0);
        expect(reviews).toBe(extra._meta || settings.approvalPolicy ? 0 : 1);
    }
});
test("[external-tools] ordinary automatic MCP routing honors read-only hints and configured approval modes", async (t) => {
    const f = await fixture(t),
        effects = [];
    const transport = new FixtureMcpTransport(
        [
            tool("read", { annotations: { readOnlyHint: true } }),
            tool("configured", { annotations: { destructiveHint: true } }),
        ],
        async (params) => {
            effects.push(params.name);
            return mcpText("owned");
        },
    );
    const runtime = await guardedFixture(t, f, {
        mcp: mcpFixture("owned", transport),
        mcpToolPolicies: { "owned/configured": { approvalMode: "approve" } },
        provider: {
            complete: () =>
                expect.unreachable(
                    "Ordinary permitted MCP action unnecessarily reached reviewer",
                ),
        },
    });
    await invoke(runtime, "mcp__owned__read");
    await invoke(runtime, "mcp__owned__configured");
    expect(effects).toStrictEqual(["read", "configured"]);
});
test("[external-tools] user reviewer honors read hints and requires UI for destructive tools", async (t) => {
    const f = await fixture(t),
        effects = [];
    const transport = new FixtureMcpTransport(
        [
            tool("read", { annotations: { readOnlyHint: true } }),
            tool("write", {
                annotations: { readOnlyHint: true, destructiveHint: true },
            }),
        ],
        async (params) => {
            effects.push(params.name);
            return mcpText("done");
        },
    );
    const runtime = await guardedFixture(t, f, {
        mcp: mcpFixture("owned", transport),
        settings: { approvalsReviewer: "user" },
        provider: {
            complete: () => expect.unreachable("User reviewer called model"),
        },
    });
    await invoke(runtime, "mcp__owned__read");
    await invoke(runtime, "mcp__owned__write");
    expect(effects).toStrictEqual(["read"]);
    let prompts = 0;
    await runtime.session.bindExtensions({
        mode: "rpc",
        uiContext: {
            select: async (_title, choices) => {
                prompts++;
                return choices[0];
            },
            notify() {},
            setStatus() {},
            setWidget() {},
        },
    });
    await invoke(runtime, "mcp__owned__write");
    expect(effects).toStrictEqual(["read", "write"]);
    expect(prompts).toBe(1);
});
test("[external-tools] changed MCP metadata and cancellation during review block the call", async (t) => {
    const f = await fixture(t),
        meta = { connector_id: "owned" },
        tools = [tool("write", { _meta: meta })];
    let reviews = 0;
    const transports = [0, 1].map(
        () =>
            new FixtureMcpTransport(tools, async () =>
                expect.unreachable("Stale MCP call executed"),
            ),
    );
    const changed = await guardedFixture(t, f, {
        mcp: mcpFixture("owned", transports[0]),
        provider: {
            complete: async () => {
                reviews++;
                meta.connector_id = "replaced";
                return allowed;
            },
        },
        trustedExtensions: [toolMetaFixture("owned", tools)],
    });
    await invoke(changed, "mcp__owned__write");
    expect(reviews).toBe(1);
    const cancelled = await guardedFixture(t, f, {
        mcp: mcpFixture("owned", transports[1]),
        provider: {
            complete: async () => {
                reviews++;
                void cancelled.session.abort();
                return allowed;
            },
        },
    });
    await invoke(cancelled, "mcp__owned__write");
    expect(reviews).toBe(2);
    expect(transports.flatMap((transport) => transport.calls)).toHaveLength(0);
});
test("[external-tools] changed registration and cancellation during review cannot execute a registered adapter", async (t) => {
    const f = await fixture(t);
    let version = "one",
        effects = 0,
        reviews = 0,
        runtime;
    const extension = (api) =>
        api.registerTool({
            name: "owned_external",
            label: "owned",
            description: "Owned action",
            parameters: schema,
            execute: async () => {
                effects++;
                return mcpText("executed");
            },
        });
    runtime = await guardedFixture(t, f, {
        externalExtensions: [
            {
                extension,
                identifyTool: () => ({
                    kind: "extension",
                    server: "owned",
                    tool: "owned_external",
                    registration: version,
                }),
            },
        ],
        settings: { trustedTools: ["owned_external"] },
        provider: {
            complete: async () => {
                reviews++;
                version = "two";
                return allowed;
            },
        },
    });
    await invoke(runtime, "owned_external");
    expect(effects).toBe(0);
    expect(reviews).toBe(1);
    const cancelled = await guardedFixture(t, f, {
        externalExtensions: [
            {
                extension,
                identifyTool: () => ({
                    kind: "extension",
                    server: "owned",
                    tool: "owned_external",
                    registration: "fixed",
                }),
            },
        ],
        settings: { trustedTools: ["owned_external"] },
        provider: {
            complete: async () => {
                reviews++;
                void cancelled.session.abort();
                return allowed;
            },
        },
    });
    await invoke(cancelled, "owned_external");
    expect(effects).toBe(0);
    expect(reviews).toBe(2);
});
test("[external-tools] real MCP stdio server reuses an approval of the same tool version and preserves structured results", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt");
    let reviews = 0;
    const runtime = await guardedFixture(t, f, {
        mcp: {
            loadConfig: () => ({
                servers: [
                    {
                        name: "stdio",
                        config: {
                            command: process.execPath,
                            args: [
                                resolve("tests/harness/mcp-server.mjs"),
                                target,
                            ],
                            exposure: "direct",
                        },
                        source: "owned-stdio-fixture",
                        scope: "extension",
                    },
                ],
                errors: [],
            }),
        },
        provider: {
            complete: async () =>
                ++reviews === 1
                    ? allowed
                    : '{"outcome":"deny","rationale":"Second write is not authorized"}',
        },
    });
    const events = [];
    runtime.session.subscribe((event) => events.push(event));
    await invoke(runtime, "mcp__stdio__write_owned", "approved-effect");
    await invoke(runtime, "mcp__stdio__write_owned", "reused-effect");
    expect(reviews).toBe(1);
    expect(await readFile(target, "utf8")).toBe("reused-effect");
    const result = events.find(
        (event) => event.type === "tool_execution_end" && !event.isError,
    );
    expect(result.result.structuredContent.structuredContent.value).toBe(
        "approved-effect",
    );
    expect(
        events.some(
            (event) => event.type === "tool_execution_end" && event.isError,
        ),
    ).toBeFalsy();
});
test("[external-tools] explicit human-input flag uses a fresh human dialog without automatic inference", async (t) => {
    const f = await fixture(t);
    let effects = 0,
        prompts = 0;
    const tools = [
        tool("confirm", { _meta: { codex_requires_user_input: true } }),
    ];
    const transport = new FixtureMcpTransport(tools, async () => {
        effects++;
        return mcpText("human-confirmed");
    });
    const runtime = await guardedFixture(t, f, {
        mcp: mcpFixture("owned", transport),
        provider: {
            complete: () =>
                expect.unreachable("Required human input reached model"),
        },
        trustedExtensions: [toolMetaFixture("owned", tools)],
    });
    await runtime.session.bindExtensions({
        mode: "rpc",
        uiContext: {
            select: async (_title, choices) => {
                expect(choices).toStrictEqual(["Allow once", "Deny"]);
                prompts++;
                return prompts === 1 ? choices[0] : choices[1];
            },
            notify() {},
            setStatus() {},
            setWidget() {},
        },
    });
    await invoke(runtime, "mcp__owned__confirm");
    await invoke(runtime, "mcp__owned__confirm");
    expect(prompts).toBe(2);
    expect(effects).toBe(1);
});
test("[external-tools] project MCP startup requires a recorded or explicit project trust decision", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt");
    await mkdir(join(f.workspace, ".pi"));
    await writeFile(
        join(f.workspace, ".pi", "mcp.json"),
        JSON.stringify({
            mcpServers: {
                project: {
                    command: process.execPath,
                    args: [
                        resolve("tests/harness/mcp-server.mjs"),
                        target,
                        "startup-effect",
                    ],
                    exposure: "direct",
                },
            },
        }),
    );
    const untrusted = await guardedFixture(t, f, {
        settingsManager: undefined,
    });
    await planStream(untrusted.session, []);
    await untrusted.session.prompt("Do not start untrusted project resources.");
    expect(await readFile(target, "utf8")).toBe("unchanged");
    const trusted = await guardedFixture(t, f, {
        settingsManager: undefined,
        isProjectTrusted: true,
    });
    await planStream(trusted.session, []);
    await trusted.session.prompt("Load the explicitly trusted owned project.");
    expect(await readFile(target, "utf8")).toBe("started-by-project-config");
    await writeFile(target, "unchanged");
    new ProjectTrustStore(f.agentDir).set(f.workspace, true);
    const recorded = await guardedFixture(t, f, { settingsManager: undefined });
    await planStream(recorded.session, []);
    await recorded.session.prompt("Use the recorded owned project trust.");
    expect(await readFile(target, "utf8")).toBe("started-by-project-config");
    await writeFile(target, "unchanged");
    const explicitDeny = await guardedFixture(t, f, {
        settingsManager: undefined,
        isProjectTrusted: false,
    });
    await planStream(explicitDeny.session, []);
    await explicitDeny.session.prompt("Keep this project untrusted.");
    expect(await readFile(target, "utf8")).toBe("unchanged");
});
