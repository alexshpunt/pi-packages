import assert from "node:assert/strict";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createProfile } from "../../dist/contracts.js";
import {
    defaultProfile,
    validateSettings,
} from "../../dist/policy/index.js";
import { fixture } from "../harness/fixtures.mjs";
import { FAKE_MODEL, guardedFixture } from "../harness/pi.mjs";
import { replayReviews, replayScenario } from "../harness/scenarios.mjs";
import { shellQuote } from "../harness/shell.mjs";

const allow = {
    risk_level: "low",
    user_authorization: "high",
    outcome: "allow",
};
const deny = {
    risk_level: "high",
    user_authorization: "low",
    outcome: "deny",
    rationale: "Owned scenario denial",
};
const nodeCommand = (program) =>
    `${shellQuote(process.execPath)} -e ${shellQuote(program)}`;

async function runScenario(
    t,
    f,
    {
        calls,
        replies = [],
        options = {},
        configure,
        inspect,
        prompt = "Operate only on the owned fixture and respect denials.",
    },
) {
    const reviews = replayReviews(replies);
    const runtime = await guardedFixture(t, f, {
        ...options,
        provider: reviews.provider,
    });
    await configure?.(runtime);
    const replay = await replayScenario(runtime.session, [
        ...calls.map((call) => ({ calls: [call] })),
        { inspect },
    ]);
    t.after(replay.dispose);
    await runtime.session.prompt(prompt);
    replay.assertComplete();
    reviews.assertComplete();
    assert.ok(
        !JSON.stringify(replay.results).includes(f.secret),
        "Protected content must not reach tool results",
    );
    return { runtime, replay, reviews };
}

test("[scenario-harness] finite replay rejects extra and missing main-model or reviewer requests", async () => {
    const session = { agent: {}, subscribe: () => () => {} };
    const replay = await replayScenario(session, [{}, {}]);
    const context = { messages: [] };
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
        session.agent.streamFunction(FAKE_MODEL, context, {
            signal: cancelled.signal,
        }),
        { name: "AbortError" },
    );
    assert.equal(replay.requests.length, 0);
    await session.agent.streamFunction(FAKE_MODEL, context, {});
    assert.throws(() => replay.assertComplete(), /Every scripted main-model/);
    await session.agent.streamFunction(FAKE_MODEL, context, {});
    replay.assertComplete();
    await assert.rejects(
        session.agent.streamFunction(FAKE_MODEL, context, {}),
        /Unexpected main-model/,
    );
    assert.throws(() => replay.assertComplete(), /Script assertions/);
    const reviews = replayReviews([allow]);
    assert.throws(() => reviews.assertComplete(), /Every scripted reviewer/);
    await reviews.provider.complete({ data: "{}" });
    reviews.assertComplete();
    await assert.rejects(
        reviews.provider.complete({ data: "{}" }),
        /Unexpected reviewer/,
    );
    assert.throws(() => reviews.assertComplete(), /Reviewer script assertions/);
});

for (const tool of ["read", "grep", "find", "ls", "write", "edit"]) {
    test(`[boundary-matrix] ${tool}: workspace control succeeds and protected target never reaches review`, async (t) => {
        const f = await fixture(t),
            allowed = join(f.workspace, "owned.txt"),
            protectedFile = join(f.control, "protected.txt");
        await writeFile(allowed, "owned fixture");
        const argsFor = (file, directory) => {
            if (tool === "grep")
                return { path: directory, pattern: "owned", literal: true };
            if (tool === "find") return { path: directory, pattern: "*.txt" };
            if (tool === "ls") return { path: directory };
            if (tool === "write")
                return { path: file, content: "changed fixture" };
            if (tool === "edit")
                return {
                    path: file,
                    edits: [
                        {
                            oldText: "owned fixture",
                            newText: "changed fixture",
                        },
                    ],
                };
            return { path: file };
        };
        const { replay } = await runScenario(t, f, {
            calls: [
                { name: tool, args: argsFor(allowed, f.workspace) },
                { name: tool, args: argsFor(protectedFile, f.control) },
            ],
            inspect: async ({ results }) => {
                assert.equal(
                    results[0].isError,
                    false,
                    JSON.stringify(results[0]),
                );
                assert.equal(results[1].isError, true);
                assert.equal(await readFile(protectedFile, "utf8"), f.secret);
            },
        });
        assert.equal(
            await readFile(allowed, "utf8"),
            ["write", "edit"].includes(tool)
                ? "changed fixture"
                : "owned fixture",
        );
        assert.match(JSON.stringify(replay.results[1]), /Protected path/);
    });
}

for (const isTempExcluded of [false, true]) {
    test(`[boundary-matrix] temporary paths: ${isTempExcluded ? "excluded roots require review" : "default writable temporary roots permit the owned write"}`, async (t) => {
        const f = await fixture(t),
            target = join(f.outside, "sentinel.txt");
        const settings = validateSettings({
            excludeSlashTmp: isTempExcluded,
            excludeTmpdir: isTempExcluded,
        });
        const profile = await defaultProfile(f.workspace, settings, [
            f.control,
        ]);
        const { replay } = await runScenario(t, f, {
            calls: [
                { name: "read", args: { path: target } },
                {
                    name: "write",
                    args: { path: target, content: "temporary control" },
                },
            ],
            replies: isTempExcluded ? [deny] : [],
            options: { profile, settings },
        });
        assert.equal(
            replay.results[0].isError,
            false,
            "Default readable roots permit ordinary outside reads",
        );
        assert.equal(replay.results[1].isError, isTempExcluded);
        assert.equal(
            await readFile(target, "utf8"),
            isTempExcluded ? "unchanged" : "temporary control",
        );
    });
}

for (const row of [
    {
        id: "low-policy-denial",
        reply: { risk_level: "low", outcome: "deny" },
        code: "AUTO_REVIEW_DENIED",
    },
    {
        id: "high-insufficient-authorization",
        reply: {
            risk_level: "high",
            user_authorization: "low",
            outcome: "allow",
        },
        code: "AUTO_REVIEW_DENIED",
    },
    {
        id: "critical-even-with-authorization",
        reply: {
            risk_level: "critical",
            user_authorization: "high",
            outcome: "allow",
        },
        code: "AUTO_REVIEW_DENIED",
    },
    {
        id: "high-authorized",
        reply: {
            risk_level: "high",
            user_authorization: "high",
            outcome: "allow",
        },
        canWrite: true,
    },
    {
        id: "provider-outage",
        reply: new Error("Owned provider outage"),
        code: "AUTO_REVIEW_FAILED",
    },
    {
        id: "malformed-assessment",
        reply: "not JSON",
        code: "AUTO_REVIEW_FAILED",
    },
    {
        id: "injected-permission-fields",
        reply: { ...allow, writePaths: ["/"] },
        code: "AUTO_REVIEW_FAILED",
    },
]) {
    test(`[review-routing] ${row.id}: assessment reaches the final Pi write and model-visible result`, async (t) => {
        const f = await fixture(t),
            target = join(f.outside, "sentinel.txt");
        const { replay } = await runScenario(t, f, {
            calls: [
                {
                    name: "write",
                    args: { path: target, content: "reviewed change" },
                },
            ],
            replies: [row.reply],
        });
        assert.equal(replay.results[0].isError, !row.canWrite);
        assert.equal(
            await readFile(target, "utf8"),
            row.canWrite ? "reviewed change" : "unchanged",
        );
        if (row.code)
            assert.ok(JSON.stringify(replay.results[0]).includes(row.code));
    });
}

for (const category of ["sandbox", "rules"]) {
    test(`[review-routing] disabled ${category} approval rejects before provider and still allows ordinary work`, async (t) => {
        const f = await fixture(t),
            target = join(f.outside, "sentinel.txt"),
            allowed = join(f.workspace, "ordinary.txt");
        const isRule = category === "rules";
        const command = nodeCommand(
            `require('fs').writeFileSync(${JSON.stringify(target)},'forbidden')`,
        );
        const { replay } = await runScenario(t, f, {
            calls: [
                { name: "write", args: { path: allowed, content: "ordinary" } },
                isRule
                    ? { name: "bash", args: { command } }
                    : {
                          name: "write",
                          args: { path: target, content: "forbidden" },
                      },
            ],
            options: {
                settings: {
                    approvalPolicy: { sandbox: isRule, rules: !isRule },
                    commandRules: isRule
                        ? [{ prefix: [process.execPath], decision: "ask" }]
                        : [],
                },
            },
        });
        assert.deepEqual(
            replay.results.map((result) => result.isError),
            [false, true],
        );
        assert.equal(await readFile(allowed, "utf8"), "ordinary");
        assert.equal(await readFile(target, "utf8"), "unchanged");
    });
}

for (const isWrapped of [false, true]) {
    test(`[review-routing] forbidden rule outranks an allow rule for ${isWrapped ? "wrapped" : "direct"} shell execution`, async (t) => {
        const f = await fixture(t),
            target = join(f.workspace, "must-not-exist.txt");
        const command = nodeCommand(
            `require('fs').writeFileSync(${JSON.stringify(target)},'forbidden')`,
        );
        const { replay } = await runScenario(t, f, {
            options: {
                settings: {
                    commandRules: [
                        { prefix: [process.execPath], decision: "allow" },
                        { prefix: [process.execPath], decision: "deny" },
                    ],
                },
            },
            calls: [
                { name: "bash", args: { command: "printf ordinary-control" } },
                {
                    name: "bash",
                    args: {
                        command: isWrapped
                            ? `/bin/bash -lc ${shellQuote(command)}`
                            : command,
                    },
                },
            ],
        });
        assert.deepEqual(
            replay.results.map((result) => result.isError),
            [false, true],
        );
        assert.match(JSON.stringify(replay.results[1]), /forbidden/);
        await assert.rejects(readFile(target), { code: "ENOENT" });
    });
}

test("[review-routing] a timed-out review and its late allow reply cannot trigger execution or user fallback", async (t) => {
    const f = await fixture(t),
        target = join(f.outside, "sentinel.txt");
    const lateReply = Promise.withResolvers();
    let reviewSignal,
        prompts = 0;
    t.after(() => lateReply.resolve(allow));
    const { replay } = await runScenario(t, f, {
        options: { settings: { reviewTimeoutMs: 50 } },
        configure: (runtime) =>
            runtime.session.bindExtensions({
                mode: "rpc",
                uiContext: {
                    select: async () => {
                        prompts++;
                        return "Allow once";
                    },
                    notify: () => {},
                    setStatus: () => {},
                    setWidget: () => {},
                },
            }),
        calls: [
            { name: "write", args: { path: target, content: "late change" } },
        ],
        replies: [
            (_request, options) => {
                assert.equal(options.timeoutMs, 50);
                reviewSignal = options.signal;
                return lateReply.promise;
            },
        ],
    });
    assert.equal(reviewSignal.aborted, true);
    assert.equal(prompts, 0);
    assert.equal(replay.results[0].isError, true);
    assert.match(JSON.stringify(replay.results[0]), /AUTO_REVIEW_TIMEOUT/);
    assert.doesNotMatch(
        JSON.stringify(replay.results[0]),
        /AUTO_REVIEW_DENIED/,
    );
    lateReply.resolve(allow);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await readFile(target, "utf8"), "unchanged");
    const audit = (
        await readFile(join(f.agentDir, "guard/audit.jsonl"), "utf8")
    )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    assert.equal(
        audit.filter((item) => item.review?.status === "timed-out").length,
        1,
    );
    assert.equal(audit.filter((item) => item.event === "execution").length, 0);
});

// Each tool call needs its own approval; approval is not an OS write grant.
for (const location of ["cwd", "temporary"]) {
    test(`[scoped-grants] read-only ${location} sibling stays protected after an exact-file approval`, async (t) => {
        const f = await fixture(t),
            target = join(f.outside, "sentinel.txt");
        const sibling = join(
            location === "cwd" ? f.workspace : f.outside,
            "unrequested.txt",
        );
        await writeFile(sibling, "unchanged sibling");
        const profile = createProfile({
            ...f.profile,
            mode: "read-only",
            readRoots: ["/"],
            writeRoots: [],
        });
        const { replay } = await runScenario(t, f, {
            options: { profile, settings: { mode: "read-only" } },
            calls: [
                { name: "write", args: { path: target, content: "approved" } },
                { name: "write", args: { path: sibling, content: "escaped" } },
                { name: "write", args: { path: target, content: "later" } },
            ],
            replies: [
                (request) => {
                    assert.deepEqual(
                        JSON.parse(request.data).requestedPermissionDelta
                            .writePaths,
                        [target],
                    );
                    return allow;
                },
                () => deny,
                () => deny,
            ],
        });
        assert.deepEqual(
            replay.results.map((result) => result.isError),
            [false, true, true],
        );
        assert.equal(await readFile(target, "utf8"), "approved");
        assert.equal(await readFile(sibling, "utf8"), "unchanged sibling");
    });
}

for (const destination of ["sibling", "protected"]) {
    test(`[scoped-grants] symlink retargeted to ${destination} during review invalidates the pending shell write`, async (t) => {
        const f = await fixture(t),
            alias = join(f.workspace, "alias"),
            target = join(f.outside, "sentinel.txt");
        const sibling = join(f.root, "sibling");
        await mkdir(sibling);
        await writeFile(join(sibling, "sentinel.txt"), "sibling unchanged");
        await writeFile(join(f.control, "sentinel.txt"), "protected unchanged");
        await symlink(f.outside, alias);
        const { replay } = await runScenario(t, f, {
            calls: [
                {
                    name: "bash",
                    args: {
                        command: `printf changed > ${shellQuote(join(alias, "sentinel.txt"))}`,
                    },
                },
            ],
            replies: [
                async () => {
                    await unlink(alias);
                    await symlink(
                        destination === "protected" ? f.control : sibling,
                        alias,
                    );
                    return allow;
                },
            ],
        });
        assert.equal(replay.results[0].isError, true);
        assert.match(
            JSON.stringify(replay.results[0]),
            destination === "protected"
                ? /protected path/
                : /Resolved permissions changed/,
        );
        assert.equal(await readFile(target, "utf8"), "unchanged");
        assert.equal(
            await readFile(join(sibling, "sentinel.txt"), "utf8"),
            "sibling unchanged",
        );
        assert.equal(
            await readFile(join(f.control, "sentinel.txt"), "utf8"),
            "protected unchanged",
        );
    });
}

for (const isNested of [false, true]) {
    test(`[review-cancellation] ${isNested ? "codemode" : "direct"} tool cancellation rejects a late approving review`, {
        timeout: 15000,
    }, async (t) => {
        const f = await fixture(t),
            target = join(f.outside, "sentinel.txt");
        const started = Promise.withResolvers(),
            lateReply = Promise.withResolvers();
        const reviews = replayReviews([
            (_request, options) => {
                started.resolve(options);
                return lateReply.promise;
            },
        ]);
        const runtime = await guardedFixture(t, f, {
            provider: reviews.provider,
        });
        const args = { path: target, content: "must not run" };
        const call = isNested
            ? {
                  name: "codemode",
                  args: { code: `await tools.write(${JSON.stringify(args)});` },
              }
            : { name: "write", args };
        const replay = await replayScenario(runtime.session, [
            { calls: [call] },
        ]);
        t.after(replay.dispose);
        t.after(() => lateReply.resolve(allow));
        const pending = runtime.session.prompt(
            "Start the owned write, then stop when cancelled.",
        );
        const request = await started.promise;
        await runtime.session.abort();
        lateReply.resolve(allow);
        await pending;
        assert.equal(request.signal.aborted, true);
        replay.assertComplete({ isCancelled: true });
        reviews.assertComplete();
        assert.equal(await readFile(target, "utf8"), "unchanged");
        assert.ok(!JSON.stringify(replay.results).includes("Write successful"));
    });
}
