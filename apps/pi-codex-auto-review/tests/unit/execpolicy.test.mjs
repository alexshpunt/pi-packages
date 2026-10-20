import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAction } from "../../dist/contracts.js";
import {
    PolicyEngine,
    validateSettings,
} from "../../dist/policy/index.js";
import {
    CODEX_EXECPOLICY_REVISION,
    evaluateRules,
    parseRules,
} from "../../dist/policy/rules.js";
import { fixture } from "../harness/fixtures.mjs";

// Ported boundaries from Codex a956835d/execpolicy parser, host_executable and network-rule tests.
test("[rules] Codex Starlark functions, comprehensions, f-strings and tuple examples reach actual matching", async () => {
    const source = `
def read_rule(program):
    choices = [f"{value}" for value in ["show", "status"]]
    prefix_rule(pattern=[program, choices], decision="allow",
        match=[["git", "status", "--short"], "git show"], not_match=["git push"])
read_rule("git")
prefix_rule(pattern=["git", "show", "secret"], decision="forbidden", justification="private")
`;
    const result = await evaluateRules(
        [{ name: "generated.rules", source }],
        [
            ["git", "status", "--short"],
            ["git", "push"],
            ["git", "show", "secret"],
        ],
    );
    assert.equal(result.revision, CODEX_EXECPOLICY_REVISION);
    assert.equal(result.matches[0][0].decision, "allow");
    assert.equal(result.matches[1].length, 0);
    assert.ok(result.matches[2].some((rule) => rule.decision === "forbidden"));
    assert.throws(
        () =>
            parseRules(
                `${source}\nprefix_rule(pattern=["x"], not_match=[["x"]])`,
            ),
        /INVALID_RULES|rule engine/,
    );
    assert.throws(() => parseRules('load("external.star", "rule")\nrule()'));
});

test("[rules] host executable constraints reject aliases and preserve exact-path precedence", async () => {
    const program =
        process.platform === "win32" ? "C:/Tools/git.exe" : "/usr/bin/git";
    const other =
        process.platform === "win32" ? "C:/Other/git.exe" : "/other/git";
    const source = `host_executable(name="git", paths=[${JSON.stringify(program)}])
prefix_rule(pattern=["git", "status"], decision="allow")
prefix_rule(pattern=[${JSON.stringify(program)}, "push"], decision="forbidden")`;
    const result = await evaluateRules(
        [{ name: "host.rules", source }],
        [
            [program, "status"],
            [other, "status"],
            [program, "push"],
            ["git", "status"],
        ],
    );
    assert.equal(result.matches[0][0].decision, "allow");
    assert.equal(result.matches[1].length, 0);
    assert.equal(result.matches[2][0].decision, "forbidden");
    assert.equal(result.matches[3][0].decision, "allow");
});

test("[rules] all network_rule protocols and overlay ordering reach approval policy", async (t) => {
    const f = await fixture(t);
    const paths = [
        join(f.control, "base.rules"),
        join(f.control, "overlay.rules"),
    ];
    await writeFile(
        paths[0],
        `
network_rule(host="api.example.com", protocol="https", decision="allow")
network_rule(host="blocked.example.com", protocol="http", decision="forbidden")
network_rule(host="tcp.example.com", protocol="socks5_tcp", decision="allow")
network_rule(host="udp.example.com", protocol="socks5_udp", decision="forbidden")
network_rule(host="[::1]:443", protocol="https", decision="allow")
`,
    );
    await writeFile(
        paths[1],
        `
network_rule(host="api.example.com", protocol="https_connect", decision="forbidden")
network_rule(host="api.example.com", protocol="http-connect", decision="allow")
network_rule(host="prompt.example.com", protocol="https", decision="prompt")
`,
    );
    const policy = new PolicyEngine(
        validateSettings({ ruleFiles: paths }),
        f.profile,
    );
    await policy.initialize(f.workspace);
    const action = (host) =>
        createAction(
            {
                toolCallId: "network-rule",
                tool: "bash",
                args: { command: `curl ${JSON.stringify(`https://${host}`)}` },
                cwd: f.workspace,
                source: "model",
                sessionId: "s",
                policyRevision: policy.revision,
            },
            policy.profile,
        );
    assert.equal(
        (await policy.evaluate(action("api.example.com"))).kind,
        "allow",
    );
    assert.equal(
        (await policy.evaluate(action("blocked.example.com"))).isHardDeny,
        true,
    );
    assert.equal(
        (await policy.evaluate(action("prompt.example.com"))).kind,
        "ask",
    );
    assert.ok(policy.profile.allowedDomains.includes("tcp.example.com"));
    assert.ok(policy.profile.deniedDomains.includes("udp.example.com"));
    assert.ok(!policy.profile.deniedDomains.includes("api.example.com"));
    assert.ok(policy.profile.allowedDomains.includes("::1"));
    assert.equal((await policy.evaluate(action("[::1]"))).kind, "allow");
});

test("[rules] malformed rules, cancelled evaluation and oversized requests fail closed", async () => {
    await assert.rejects(
        evaluateRules([
            {
                name: "bad.rules",
                source: 'network_rule(host="ok.example", protocol="smtp", decision="allow")',
            },
        ]),
        /rule engine/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        evaluateRules(
            [{ name: "empty.rules", source: "" }],
            [],
            controller.signal,
        ),
    );
    await assert.rejects(
        evaluateRules([
            { name: "large.rules", source: "#".repeat(9 * 1024 * 1024) },
        ]),
        /size/,
    );
});
