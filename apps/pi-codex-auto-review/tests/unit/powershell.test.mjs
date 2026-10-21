import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAction, createProfile, decision } from "../../dist/contracts.js";
import { PolicyEngine, validateSettings } from "../../dist/policy/index.js";
import { analyzePowerShell } from "../../dist/policy/powershell.js";
import { powershellRuleCommands } from "../../dist/policy/rules.js";
import { isReadOnlyReview } from "../../dist/review/read-only.js";
import { fixture } from "../harness/fixtures.mjs";

const corpus = JSON.parse(
    await readFile(
        new URL("../fixtures/powershell-lowering.json", import.meta.url),
        "utf8",
    ),
);
expect(corpus.reference.revision).toBe(
    "80b88a700e4300022fe1893ecca9b8376d0c85d9",
);
// Literal forms Codex lowers through tree-sitter that this hand-written grammar keeps
// opaque: comments and `#` inside a bare word. Opaque scripts match the outer invocation.
const MORE_CONSERVATIVE = new Set([
    "trailing_comment",
    "hash_inside_token",
    "hash_inside_recovered_command_token",
    "block_comment_before_command",
]);
for (const entry of corpus.cases) {
    test(`[powershell] Codex lowering parity: ${entry.name}`, () => {
        const outer = [["pwsh", "-Command", entry.script]];
        const lowered = powershellRuleCommands(entry.script, "pwsh");
        if (entry.expected === null || MORE_CONSERVATIVE.has(entry.name))
            expect(lowered).toStrictEqual(outer);
        else expect(lowered).toStrictEqual(entry.expected);
        if (MORE_CONSERVATIVE.has(entry.name))
            expect(entry.expected).not.toBeNull();
    });
}

test("[powershell] literal analysis records redirections, pipelines and rejects dynamic forms", () => {
    expect(analyzePowerShell("Write-Output hi > out.txt")).toMatchObject({
        isSupported: true,
        commands: [{ argv: ["Write-Output", "hi"], writes: ["out.txt"] }],
    });
    expect(
        analyzePowerShell("Get-Content a 2>> err.txt").commands[0].writes,
    ).toStrictEqual(["err.txt"]);
    expect(
        analyzePowerShell("Get-ChildItem |\n  Remove-Item").commands.map(
            (command) => command.receivesPipeline,
        ),
    ).toStrictEqual([false, true]);
    expect(
        analyzePowerShell("Get-ChildItem && Remove-Item x").commands[1]
            .receivesPipeline,
    ).toBe(false);
    for (const script of [
        "Get-Content a 2>&1",
        "Get-Content a *>&1",
        "Get-Content ~/secret",
        "Get-Content '~/secret'",
        "Get-Content a |",
        "Get-Content a |; Remove-Item b",
        "Get-Content a & Remove-Item b",
        ". .\\profile.ps1",
        "'Get-Content' a",
        "exit 1",
        "Get-Content a`\nb",
        "Get-Content < input.txt",
        "Write-Output \"a\"\"b\"",
        "Write-Output `n",
        "Remove-Item a\u00A0b",
    ])
        expect(analyzePowerShell(script).isSupported, script).toBe(false);
    expect(() => analyzePowerShell(" ")).toThrow(
        expect.objectContaining({ code: "INVALID_COMMAND" }),
    );
});

test("[powershell] rule matching unwraps nested PowerShell and bash up to the bash depth", () => {
    expect(
        powershellRuleCommands(
            "pwsh -NoProfile -Command 'git push; bash -c \"git status\"'",
            "pwsh",
        ),
    ).toStrictEqual([
        ["git", "push"],
        ["git", "status"],
    ]);
    // A script that is not the final argument or uses another flag stays the visible invocation.
    expect(
        powershellRuleCommands("pwsh -File x.ps1 'git push'", "pwsh"),
    ).toStrictEqual([["pwsh", "-File", "x.ps1", "git push"]]);
    expect(
        powershellRuleCommands("Get-Content a > b", "C:\\pwsh.exe"),
    ).toStrictEqual([["C:\\pwsh.exe", "-Command", "Get-Content a > b"]]);
    let script = "git push";
    for (let depth = 0; depth < 6; depth++)
        script = `powershell -Command '${script.replaceAll("'", "''")}'`;
    expect(powershellRuleCommands(script, "pwsh").flat()).toContain(
        "-Command",
    );
    // Windows executable names are case-insensitive and may carry PATHEXT suffixes.
    expect(
        powershellRuleCommands(
            "PWSH.EXE -c 'git push'",
            "pwsh",
            0,
            "win32",
        ),
    ).toStrictEqual([["git", "push"]]);
});

async function setup(t, settings = {}) {
    const f = await fixture(t),
        profile = createProfile({
            ...f.profile,
            readOnlyPaths: [join(f.workspace, ".git")],
            allowedDomains: settings.allowedDomains ?? [],
        });
    const policy = new PolicyEngine(validateSettings(settings), profile);
    const evaluate = (command, extra = {}) =>
        policy.evaluate(
            createAction(
                {
                    toolCallId: "call",
                    tool: "powershell",
                    args: { command, ...extra },
                    source: "model",
                    cwd: f.workspace,
                    sessionId: "session",
                    policyRevision: policy.revision,
                },
                profile,
            ),
        );
    return { ...f, profile, policy, evaluate };
}

test("[powershell] cmdlets, aliases and named parameters share bash path classification", async (t) => {
    const f = await setup(t);
    const protectedFile = join(f.control, "protected.txt");
    for (const command of [
        "Get-Content notes.txt",
        "cat notes.txt",
        "gc -LiteralPath notes.txt -Raw",
        "Get-ChildItem -Recurse -Filter *.ts",
        "Set-Content -Path out.txt -Value text",
        "New-Item -Path sub -Name new.txt -ItemType File",
        "mkdir build",
        "Copy-Item a.txt b.txt",
        "Remove-Item -LiteralPath build -Recurse -Force",
        "Rename-Item a.txt b.txt",
        "Write-Output ok | Out-File -FilePath out.txt",
        "Get-Content a.txt | Measure-Object -Line",
        "git status",
        "git.exe log -1",
        "rg pattern src",
        "Write-Output hi > out.txt",
    ])
        expect((await f.evaluate(command)).kind, command).toBe("allow");
    for (const command of [
        `Get-Content ${protectedFile}`,
        `type '${protectedFile}'`,
        `Remove-Item -LiteralPath '${protectedFile}'`,
        `Set-Content -Value x -Path '${protectedFile}'`,
        `Copy-Item notes.txt -Destination '${protectedFile}'`,
        `Move-Item '${protectedFile}' moved.txt`,
        `New-Item -Path '${f.control}' -Name protected.txt`,
        `Write-Output x > '${protectedFile}'`,
        `Invoke-WebRequest https://example.com -OutFile '${protectedFile}'`,
        `Remove-Item '${f.control}/*'`,
        `rg secret '${f.control}'`,
        // Even unsupported scripts keep literal redirection targets for deny checks.
        `Write-Output $env:X > '${protectedFile}'`,
    ]) {
        const result = await f.evaluate(command);
        expect(result.kind, command).toBe("deny");
        expect(result.isHardDeny, command).toBe(true);
    }
    for (const command of [
        "Remove-Item *.tmp",
        "Get-ChildItem | Remove-Item",
        "Get-ChildItem -Recurse | Get-Content",
        "Get-ChildItem | Select-String secret",
        "Get-Content Env:SECRET",
        "Set-Content -Path HKCU:\\Software\\x -Value 1",
        "Get-Content FileSystem::C:\\x",
        "New-Item -ItemType SymbolicLink -Path link -Value target",
        "Remove-Item",
        "Get-Content -Pa notes.txt",
        "Get-Content -Path a -Path b",
        "Set-Location ..",
        "Invoke-Expression 'Remove-Item x'",
        "Start-Process notepad",
        ".\\build.ps1",
        "C:\\tools\\rg.exe pattern",
        "Microsoft.PowerShell.Management\\Get-Content notes.txt",
        "curl https://example.com",
        "sc config x",
        "git commit -m done",
        `git log 'a"b'`,
        "Get-Content notes.txt 2>&1",
    ]) {
        const result = await f.evaluate(command);
        expect(result.kind, command).toBe("ask");
    }
    expect(
        (await f.evaluate(`Set-Content -Path ${f.outside}/x.txt -Value x`))
            .delta.writePaths,
    ).toStrictEqual([join(f.outside, "x.txt")]);
    const network = await f.evaluate("iwr https://example.com/data");
    expect(network.kind).toBe("ask");
    expect(network.delta.domains).toStrictEqual(["example.com"]);
    const git = await f.evaluate("git commit -m done");
    expect(git.delta.writePaths).toStrictEqual([join(f.workspace, ".git")]);
});

test("[powershell] redirection targets resolve wildcards like Out-File -FilePath", async (t) => {
    const f = await setup(t);
    for (const command of [
        "Write-Output x > '.gi?\\HEAD'",
        "Write-Output x > .gi?\\HEAD",
        "Write-Output x >> '.gi?/HEAD'",
        "Write-Output x 2> '.g[i]t/config'",
        "Write-Output x *> .gi*/config",
    ]) {
        const result = await f.evaluate(command);
        expect(result.kind, command).toBe("ask");
        expect(result.unboundTargets, command).toStrictEqual(["write"]);
    }
    for (const command of [
        `Write-Output x > '${f.control}/protecte?.txt'`,
        `Write-Output x >> ${f.control}/protecte*.txt`,
        `Write-Output x 2> '${f.control}/[p]rotected.txt'`,
        `Write-Output x *> '${f.control}/protecte?.txt'`,
    ]) {
        const result = await f.evaluate(command);
        expect(result.kind, command).toBe("deny");
        expect(result.isHardDeny, command).toBe(true);
    }
    // Literal redirection targets stay exact and keep ordinary scope.
    expect((await f.evaluate("Write-Output x > out.txt")).kind).toBe("allow");
});

test("[powershell] trusted rules also match the documented cmdlet name of aliases and other casings", async (t) => {
    const forbidden = await setup(t, {
        commandRules: [
            { prefix: ["Remove-Item"], decision: "deny" },
            { prefix: ["Get-Content"], decision: "allow" },
        ],
    });
    for (const command of [
        "rm x",
        "del x",
        "remove-item x",
        "REMOVE-ITEM x",
        "Remove-Item x",
        "Get-Content a; ri x",
    ])
        expect((await forbidden.evaluate(command)).kind, command).toBe("deny");
    const alias = await forbidden.evaluate("cat notes.txt");
    expect(alias.authority?.kind).toBe("command-rule");
    const exact = await setup(t, {
        commandRules: [{ prefix: ["rm"], decision: "deny" }],
    });
    expect((await exact.evaluate("rm x")).kind).toBe("deny");
    // Codex's exact match stays a subset: the alias rule does not reach other spellings.
    expect((await exact.evaluate("Remove-Item x")).kind).toBe("allow");
    const rules = join(exact.control, "powershell.rules");
    await writeFile(
        rules,
        'prefix_rule(pattern=["Remove-Item"], decision="forbidden")\nprefix_rule(pattern=["Get-Content"], decision="prompt")',
    );
    const compiled = await setup(t, { ruleFiles: [rules] });
    await compiled.policy.initialize(compiled.workspace);
    expect((await compiled.evaluate("del x")).kind).toBe("deny");
    expect(await compiled.evaluate("gc notes.txt")).toMatchObject({
        kind: "ask",
        approvalCategory: "rules",
    });
});

test("[powershell] cmdlet names apply only to commands lowered from PowerShell, not nested bash", async (t) => {
    const f = await setup(t, {
        commandRules: [{ prefix: ["Sort-Object"], decision: "allow" }],
    });
    const nested = await f.evaluate("bash -c 'sort -o x.txt notes.txt'");
    expect(nested.kind).not.toBe("allow");
    expect(nested.authority).toBeUndefined();
    for (const command of [
        "sh -c 'sort notes.txt'",
        "pwsh -c 'bash -c \"sort notes.txt\"'",
    ])
        expect((await f.evaluate(command)).authority, command).toBeUndefined();
    for (const command of ["sort notes.txt", "pwsh -c 'sort notes.txt'"]) {
        const direct = await f.evaluate(command);
        expect(direct.kind, command).toBe("allow");
        expect(direct.authority?.kind, command).toBe("command-rule");
    }
});

test("[powershell] trusted allow rules do not authorize targets without a canonical location", async (t) => {
    const f = await setup(t, {
        commandRules: [
            { prefix: ["Set-Content"], decision: "allow" },
            { prefix: ["Remove-Item"], decision: "allow" },
        ],
    });
    for (const command of [
        "Set-Content -Path HKCU:\\X -Value 1",
        "Remove-Item *.tmp",
        `Set-Content -Path '${f.outside}/out?.txt' -Value 1`,
    ]) {
        const result = await f.evaluate(command);
        expect(result.kind, command).toBe("ask");
        expect(result.authority, command).toBeUndefined();
        expect(result.unboundTargets, command).toStrictEqual(["write"]);
    }
    // Located targets keep the rule's authority, including outside the ordinary roots.
    const located = await f.evaluate(
        `Set-Content -Path '${f.outside}/out.txt' -Value 1`,
    );
    expect(located).toMatchObject({
        kind: "allow",
        authority: { kind: "command-rule" },
        delta: { writePaths: [join(f.outside, "out.txt")] },
    });
    expect(located.unboundTargets).toBeUndefined();
    // Absolute denies still precede the rule.
    expect(
        (await f.evaluate(`Remove-Item '${f.control}/protecte?.txt'`)).kind,
    ).toBe("deny");
});

test("[powershell] network, escalation and trusted rules follow the bash contracts", async (t) => {
    const f = await setup(t, {
        allowedDomains: ["example.com"],
        commandRules: [
            { prefix: ["git", "push"], decision: "deny" },
            { prefix: ["Get-Content"], decision: "allow" },
        ],
    });
    expect((await f.evaluate("irm https://example.com/x")).kind).toBe(
        "allow",
    );
    expect(
        (await f.evaluate("iwr https://example.com -Proxy http://proxy:8080"))
            .kind,
    ).toBe("ask");
    expect((await f.evaluate("git status; git push")).kind).toBe("deny");
    expect(
        (await f.evaluate("pwsh -NoProfile -c 'git push origin main'")).kind,
    ).toBe("deny");
    const allowed = await f.evaluate("Get-Content notes.txt");
    expect(allowed.authority?.kind).toBe("command-rule");
    const escalated = await f.evaluate("Get-Content notes.txt", {
        sandbox_permissions: "require_escalated",
    });
    expect(escalated.kind).toBe("allow");
    const reviewed = await f.evaluate("Write-Output ok", {
        sandbox_permissions: "require_escalated",
    });
    expect(reviewed).toMatchObject({
        kind: "ask",
        authority: { kind: "reviewed-command" },
    });
});

test("[powershell] read-only reuse covers single literal reads only", async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.workspace, "notes.txt"), "notes");
    const ask = (action) => decision(action, "ask", "Review");
    const action = (command, extra = {}) =>
        f.action("powershell", { command, ...extra });
    for (const command of [
        "Get-Content notes.txt",
        "gci -Recurse",
        "Select-String -Pattern todo -Path notes.txt",
        "git --no-pager status",
        "rg todo",
    ])
        expect(isReadOnlyReview(action(command), ask(action(command))), command).toBe(
            true,
        );
    for (const command of [
        "Get-Content notes.txt | Measure-Object",
        "Get-Content notes.txt; Get-Content b",
        "Get-Content notes.txt > copy.txt",
        "Get-Content *.txt",
        "Get-Content Env:X",
        "Remove-Item notes.txt",
        "rg --pre=helper.exe todo",
        "git diff",
        "C:\\tools\\rg.exe todo",
        "Get-Content $x",
    ])
        expect(isReadOnlyReview(action(command), ask(action(command))), command).toBe(
            false,
        );
});
