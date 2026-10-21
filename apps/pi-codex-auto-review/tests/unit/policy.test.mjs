import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
    createAction,
    createProfile,
} from "../../dist/contracts.js";
import {
    analyzeShell,
    canonicalPath,
    defaultProfile,
    isWithin,
    loadSettings,
    PolicyEngine,
    resolveToolPath,
    validateSettings,
} from "../../dist/policy/index.js";
import {
    matchesRule,
    parseRules,
    ruleCommands,
} from "../../dist/policy/rules.js";
import { fixture } from "../harness/fixtures.mjs";

async function setup(t, settings = {}, profileOverrides = {}) {
    const f = await fixture(t),
        profile = createProfile({ ...f.profile, ...profileOverrides });
    const policy = new PolicyEngine(validateSettings(settings), profile);
    const action = (tool, args, extra = {}) =>
        createAction(
            {
                toolCallId: "call",
                tool,
                args,
                source: "model",
                cwd: f.workspace,
                sessionId: "session",
                policyRevision: policy.revision,
                ...extra,
            },
            profile,
        );
    return {
        ...f,
        profile,
        policy,
        action,
        evaluate: (tool, args) => policy.evaluate(action(tool, args)),
    };
}
test("[paths] path-prefix escapes, symlink ancestors and nonexistent targets are resolved", async (t) => {
    const f = await setup(t);
    await symlink(f.control, join(f.workspace, "link"));
    await symlink(f.outside, join(f.workspace, "outside-link"));
    expect(
        (await f.evaluate("read", { path: "link/protected.txt" })).kind,
    ).toBe("deny");
    expect(
        (
            await f.evaluate("write", {
                path: "outside-link/new.txt",
                content: "x",
            })
        ).kind,
    ).toBe("ask");
    expect(
        (await f.evaluate("write", { path: "nested/new.txt", content: "x" }))
            .kind,
    ).toBe("allow");
    expect(
        (await f.evaluate("read", { path: `${f.workspace}-other/a` })).kind,
    ).toBe("ask");
    expect(isWithin(`${f.workspace}-other`, f.workspace)).toBe(false);
    expect(
        await canonicalPath("outside-link/missing/target", f.workspace),
    ).toBe(join(f.outside, "missing/target"));
    expect(
        (await f.evaluate("read", { path: "../control/protected.txt" }))
            .isHardDeny,
    ).toBe(true);
    for (const path of [
        `@${f.control}/protected.txt`,
        `file://${f.control}/protected.txt`,
    ])
        expect((await f.evaluate("read", { path })).isHardDeny).toBe(true);
    expect(
        await resolveToolPath(
            "~/control/protected.txt",
            f.workspace,
            false,
            f.root,
        ),
    ).toBe(join(f.control, "protected.txt"));
});
test("[rules] deny outranks allow for every compound segment and stale identities", async (t) => {
    const f = await setup(t, {
        commandRules: [
            { prefix: ["git"], decision: "allow" },
            { prefix: ["git", "push"], decision: "deny" },
        ],
    });
    expect(
        (await f.evaluate("bash", { command: "git status && git push" })).kind,
    ).toBe("deny");
    expect(
        (await f.evaluate("bash", { command: "git status | git push" })).kind,
    ).toBe("deny");
    expect(
        (await f.evaluate("bash", { command: "git status; git push" })).kind,
    ).toBe("deny");
    expect((await f.evaluate("bash", { command: "gitx status" })).kind).toBe(
        "ask",
    );
    expect(
        (
            await f.policy.evaluate(
                f.action("read", { path: "a" }, { policyRevision: "stale" }),
            )
        ).kind,
    ).toBe("deny");
    expect((await f.evaluate("unverified", { readOnlyHint: true })).kind).toBe(
        "ask",
    );
});
test("[shell] ordinary reads run directly and advanced syntax cannot borrow a prefix grant", async (t) => {
    const f = await setup(t, {
        commandRules: [
            { prefix: ["node"], decision: "allow" },
            { prefix: ["echo"], decision: "allow" },
        ],
    });
    expect(analyzeShell("printf '%s' 'a b'").commands[0].argv).toStrictEqual([
        "printf",
        "%s",
        "a b",
    ]);
    expect(
        (await f.evaluate("bash", { command: "printf '%s' 'a b'" })).kind,
    ).toBe("allow");
    for (const command of [
        "echo $(node dangerous.js)",
        "echo `whoami`",
        "echo $HOME",
        "echo *.txt",
        "echo ok # comment",
        "echo ok & node a",
        "A=1 echo ok",
        "cat <<EOF",
        "echo 'unclosed",
    ]) {
        const result = await f.evaluate("bash", { command });
        expect(result.kind, command).toBe("ask");
        expect(result.authority, command).toBe(undefined);
    }
    const interpreter = await f.evaluate("bash", {
        command: 'node -e "process.exit(0)"',
    });
    expect(interpreter.authority.kind).toBe("command-rule");
    expect((await f.evaluate("bash", { command: "npm test" })).kind).toBe(
        "ask",
    );
    expect(
        (
            await f.evaluate("bash", {
                command: `echo x > '${f.control}/protected.txt'`,
            })
        ).kind,
    ).toBe("deny");
    const result = await f.evaluate("bash", {
        command: `echo x > '${f.outside}/sentinel.txt'`,
    });
    expect(result.kind).toBe("ask");
    expect(result.delta.writePaths).toStrictEqual([
        join(f.outside, "sentinel.txt"),
    ]);
    const externalRead = await f.evaluate("bash", {
        command: `cat '${f.outside}/sentinel.txt'`,
    });
    expect(externalRead.kind).toBe("ask");
    expect(externalRead.delta.readPaths).toStrictEqual([
        join(f.outside, "sentinel.txt"),
    ]);
});
test("[rules] literal Codex prefix_rule grammar validates examples and strongest decision across wrappers", async (t) => {
    const text = `# trusted rules\nprefix_rule(pattern=["git", ["show","status"]], decision="allow", match=["git status"], not_match=["git push"],)\nprefix_rule(pattern=["git","show"],decision="prompt",justification="Inspect before running")\nprefix_rule(pattern=["git","show","secret"],decision="forbidden")`;
    const rules = parseRules(text);
    expect(
        rules.some((rule) => matchesRule(["git", "status"], rule)),
    ).toBeTruthy();
    expect(
        rules.some((rule) => matchesRule(["git", "push"], rule)),
    ).toBeFalsy();
    expect(ruleCommands('bash -lc "git status && git show x"')).toStrictEqual([
        ["git", "status"],
        ["git", "show", "x"],
    ]);
    expect(ruleCommands("echo ok > file")).toStrictEqual([
        ["/bin/bash", "-c", "echo ok > file"],
    ]);
    for (const invalid of [
        'load("x")',
        'prefix_rule(pattern=["a"], extra="bad")',
        'prefix_rule(pattern=["a"], match=["b"])',
        "prefix_rule(pattern=[[]])",
        'prefix_rule(pattern=["a"],decision="approve")',
    ])
        expect(() => parseRules(invalid)).toThrow();
    const f = await fixture(t),
        path = join(f.control, "trusted.rules");
    await writeFile(path, text);
    const policy = new PolicyEngine(
        validateSettings({ ruleFiles: [path] }),
        f.profile,
    );
    await policy.initialize();
    const evaluate = (command) =>
        policy.evaluate(
            createAction(
                {
                    toolCallId: "rule",
                    tool: "bash",
                    args: { command },
                    cwd: f.workspace,
                    source: "model",
                    sessionId: "s",
                    policyRevision: policy.revision,
                },
                f.profile,
            ),
        );
    expect((await evaluate("git status")).authority.kind).toBe("command-rule");
    expect(
        (await evaluate('bash -lc "git status && git show x"'))
            .approvalCategory,
    ).toBe("rules");
    expect((await evaluate("git status && git show secret")).isHardDeny).toBe(
        true,
    );
    expect((await evaluate("git status && echo x")).authority).toBe(undefined);
});
test("[paths] write-protected metadata remains readable and scoped elevation differs from absolute denial", async (t) => {
    const f = await fixture(t),
        git = join(f.workspace, ".git");
    await mkdir(git);
    await writeFile(join(git, "HEAD"), "owned");
    const setupValue = await setup(t, {}, {}); // Existing absolute denyRead/denyWrite coverage remains separate.
    expect(
        (
            await setupValue.evaluate("read", {
                path: join(setupValue.control, "protected.txt"),
            })
        ).kind,
    ).toBe("deny");
    const profile = createProfile({
        ...f.profile,
        denyWrite: [...f.profile.denyWrite, git],
    });
    const policy = new PolicyEngine(validateSettings({}), profile);
    const action = (command) =>
        createAction(
            {
                toolCallId: "metadata",
                tool: "bash",
                args: { command },
                cwd: f.workspace,
                source: "model",
                sessionId: "s",
                policyRevision: policy.revision,
            },
            profile,
        );
    expect((await policy.evaluate(action("cat .git/HEAD"))).kind).toBe("allow");
    expect((await policy.evaluate(action("ls .git"))).kind).toBe("allow");
    expect(
        (await policy.evaluate(action("echo x > .git/HEAD"))).isHardDeny,
    ).toBe(true);
    const basePolicy = new PolicyEngine(
        validateSettings({}),
        createProfile({ ...f.profile, readOnlyPaths: [git] }),
    );
    const request = createAction(
        {
            ...action("echo x > .git/HEAD"),
            policyRevision: basePolicy.revision,
        },
        basePolicy.profile,
    );
    expect((await basePolicy.evaluate(request)).kind).toBe("ask");
});
test("[settings] default readable roots, temporary roots and Git worktree metadata match the declared boundary", async (t) => {
    const f = await fixture(t),
        gitdir = join(f.outside, "gitdir");
    await mkdir(gitdir);
    await mkdir(join(f.workspace, ".agents"));
    await mkdir(join(f.workspace, ".codex"));
    await writeFile(join(f.workspace, ".git"), `gitdir: ${gitdir}\n`);
    const profile = await defaultProfile(f.workspace, validateSettings({}), [
        f.control,
    ]);
    expect(profile.readRoots).toStrictEqual(["/"]);
    expect(
        profile.writeRoots.includes(await canonicalPath("/tmp", f.workspace)),
    ).toBeTruthy();
    for (const path of [
        join(f.workspace, ".git"),
        join(f.workspace, ".agents"),
        join(f.workspace, ".codex"),
        gitdir,
    ])
        expect(profile.readOnlyPaths.includes(path), path).toBeTruthy();
    expect(profile.denyRead.includes(f.control)).toBeTruthy();
});
test("[shell] literal network destinations follow rules and dynamic commands require review", async (t) => {
    const f = await setup(
        t,
        {},
        {
            allowedDomains: ["*.example.com"],
            deniedDomains: ["*.blocked.example.com"],
        },
    );
    const allowed = await f.evaluate("bash", {
        command: "curl https://api.example.com",
    });
    expect(allowed.kind).toBe("allow");
    expect(allowed.delta.domains).toStrictEqual([]);
    expect(
        (await f.evaluate("bash", { command: "curl https://example.com" }))
            .kind,
    ).toBe("ask");
    expect(
        (
            await f.evaluate("bash", {
                command: "curl https://a.blocked.example.com",
            })
        ).isHardDeny,
    ).toBe(true);
    const dynamic = await f.evaluate("bash", {
        command: 'host=api.example.com; curl "http://$host/proof"',
    });
    expect(dynamic.kind).toBe("ask");
    expect(dynamic.delta.domains).toStrictEqual([]);
    const full = await f.evaluate("bash", {
        command: "node action.js",
        sandbox_permissions: "require_escalated",
    });
    expect(full.kind).toBe("ask");
    expect(full.authority.kind).toBe("reviewed-command");
    const scoped = await f.evaluate("bash", {
        command: "node action.js",
        additional_permissions: { writePaths: [join(f.outside, "owned.txt")] },
    });
    expect(scoped.kind).toBe("ask");
    expect(scoped.authority).toBe(undefined);
    expect(
        (
            await f.evaluate("bash", {
                command: "echo x",
                additional_permissions: { writePaths: [f.control] },
            })
        ).isHardDeny,
    ).toBe(true);
});
test("[settings] corrupt or weakening settings fail closed and read-only file writes require permission", async (t) => {
    const f = await setup(
        t,
        { mode: "read-only" },
        { mode: "read-only", writeRoots: [] },
    );
    expect((await f.evaluate("read", { path: "a" })).kind).toBe("allow");
    expect((await f.evaluate("write", { path: "a", content: "x" })).kind).toBe(
        "ask",
    );
    for (const settings of [
        null,
        [],
        { allowAll: true },
        { mode: "full" },
        { reviewTimeoutMs: 0 },
        { commandRules: [{ prefix: [], decision: "allow" }] },
        { allowedDomains: ["*"] },
    ])
        expect(() => validateSettings(settings)).toThrow();
    const path = join(f.control, "policy.json");
    await writeFile(path, "{bad");
    await expect(loadSettings(path)).rejects.toThrow(/could not be loaded/);
});
test("[settings] reviewer redaction settings default to empty lists and reject entries without echoing values", () => {
    expect(validateSettings({}).redaction).toStrictEqual({
        sensitiveFields: [],
        rules: [],
        exceptions: [],
        piiEntities: [],
    });
    const redaction = {
        sensitiveFields: ["sessionKey"],
        rules: [{ id: "custom.acme", pattern: "ACME_[A-Z0-9]+" }],
        exceptions: [{ ruleId: "custom.acme", value: "ACME_EXAMPLE" }],
        piiEntities: ["EMAIL_ADDRESS"],
    };
    const settings = validateSettings({ redaction });
    expect(settings.redaction).toStrictEqual(redaction);
    expect(
        validateSettings(JSON.parse(JSON.stringify(settings))),
    ).toStrictEqual(settings);
    for (const invalid of [
        null,
        [],
        { switchedOff: true },
        { sensitiveFields: "PRIVATE_FIELD_VALUE" },
        { rules: [{ id: "custom.bad", pattern: "PRIVATE_PATTERN_((" }] },
        { rules: [{ id: "acme", pattern: "PRIVATE_PATTERN_ID" }] },
        {
            rules: [
                {
                    id: "custom.flagged",
                    pattern: "PRIVATE_PATTERN_FLAGS",
                    flags: "g",
                },
            ],
        },
        {
            exceptions: [
                {
                    ruleId: "custom.acme",
                    value: "PRIVATE_EXCEPTION_VALUE",
                    note: "x",
                },
            ],
        },
        { piiEntities: ["EMAIL"] },
    ])
        expect(() => validateSettings({ redaction: invalid })).toThrow(
            expect.toSatisfy(
                (error) =>
                    error.code === "INVALID_SETTINGS" &&
                    /^Invalid redaction/.test(error.message) &&
                    !/PRIVATE_|Invalid regular expression/.test(error.message),
            ),
        );
});
