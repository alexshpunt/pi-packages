import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAction } from "../../dist/contracts.js";
import {
    canonicalPath,
    defaultProfile,
    defaultTemporaryRoots,
    PolicyEngine,
    validateSettings,
} from "../../dist/policy/index.js";
import {
    normalizeToolPathInput,
    resolveToolPath,
} from "../../dist/policy/paths.js";
import {
    bashFlavor,
    commandName,
    hasInnerGitComponent,
    isProtectedWithin,
    isRemoteWindowsPath,
    windowsBashOperandPath,
    windowsMissingTailIssue,
    windowsPathIssue,
} from "../../dist/policy/platform-paths.js";
import {
    defaultShellIdentity,
    ruleCommands,
} from "../../dist/policy/rules.js";
import { fixture } from "../harness/fixtures.mjs";

test("[windows-paths] device namespaces, streams, reserved names and local shares are rejected", () => {
    for (const path of [
        "\\\\?\\C:\\Users\\me\\.pi\\agent\\guard\\settings.json",
        "\\\\.\\C:\\x",
        "//?/C:/x",
        "\\??\\C:\\x",
        "C:settings.json",
        "C:\\repo\\settings.json:stream",
        "C:\\repo\\settings.json::$DATA",
        "C:\\repo\\NUL",
        "C:\\repo\\nul.txt",
        "C:\\repo\\COM1 .log",
        "C:\\repo\\CON.",
        "C:\\repo\\LPT\u00B9",
        "\\\\localhost\\share\\x",
        "\\\\127.0.0.1\\share\\x",
        "\\\\server\\C$\\Users",
        "\\\\WORKSTATION\\share\\x",
    ])
        expect(windowsPathIssue(path, ["workstation"]), path).toBeTruthy();
    for (const path of [
        "C:\\Users\\me\\repo\\file.txt",
        "\\\\server\\share\\file.txt",
        "relative\\file.txt",
        "C:\\repo\\console.txt",
    ])
        expect(windowsPathIssue(path, ["workstation"]), path).toBeUndefined();
});

test("[windows-paths] missing components with trailing dots, spaces or short names fail closed", () => {
    for (const tail of ["settings.json.", "guard \\x", "SETTIN~1.JSO", "a\\PROGRA~1\\b"])
        expect(windowsMissingTailIssue(tail), tail).toBeTruthy();
    for (const tail of ["", "a\\b.txt", "..\\a", "file~name.txt"])
        expect(windowsMissingTailIssue(tail), tail).toBeUndefined();
});

test("[windows-paths] protection containment folds case and normalization only where the file system does", () => {
    expect(isProtectedWithin("C:\\USERS\\me\\.PI\\guard\\x", "c:\\users\\ME\\.pi\\guard", "win32")).toBe(true);
    expect(isProtectedWithin("/Users/me/.PI/Guard/x", "/Users/me/.pi/guard", "darwin")).toBe(true);
    expect(isProtectedWithin("/Users/me/caf\u0065\u0301/x", "/Users/me/caf\u00E9", "darwin")).toBe(true);
    expect(isProtectedWithin("/home/me/.PI/guard", "/home/me/.pi/guard", "linux")).toBe(false);
    expect(isProtectedWithin("/Users/me/.pi-other", "/Users/me/.pi", "darwin")).toBe(false);
    expect(hasInnerGitComponent("C:\\repo\\.GIT\\worktrees\\x", "win32")).toBe(true);
    expect(hasInnerGitComponent("C:\\repo\\.git", "win32")).toBe(false);
    expect(hasInnerGitComponent("/repo/.git/worktrees/x", "linux")).toBe(true);
    expect(hasInnerGitComponent("/repo/.git", "linux")).toBe(false);
    expect(hasInnerGitComponent("/repo/x.git/y", "linux")).toBe(false);
});

test("[windows-paths] bash flavors map drive paths only where their runtime does", () => {
    expect(bashFlavor("C:\\Program Files\\Git\\bin\\bash.exe", "win32")).toBe("msys");
    expect(bashFlavor("C:/msys64/usr/bin/bash.exe", "win32")).toBe("msys");
    expect(bashFlavor("C:\\cygwin64\\bin\\bash.exe", "win32")).toBe("cygwin");
    expect(bashFlavor("C:\\Windows\\System32\\bash.exe", "win32")).toBe("wsl");
    expect(bashFlavor("C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe", "win32")).toBe("wsl");
    expect(bashFlavor("pi-default-shell-unresolved", "win32")).toBe("unknown");
    expect(bashFlavor("/bin/bash", "darwin")).toBe("posix");
    const cwd = "C:\\Users\\me\\repo";
    expect(windowsBashOperandPath("/c/Users/me/.pi/agent/guard/settings.json", cwd, "msys")).toStrictEqual({
        path: "C:\\Users\\me\\.pi\\agent\\guard\\settings.json",
        isExact: true,
    });
    expect(windowsBashOperandPath("/tmp/../c/Users", cwd, "msys")).toStrictEqual({ path: "C:\\Users", isExact: true });
    expect(windowsBashOperandPath("/cygdrive/c/x", cwd, "msys")).toStrictEqual({ path: "C:\\x", isExact: false });
    expect(windowsBashOperandPath("/cygdrive/d/x", cwd, "cygwin")).toStrictEqual({ path: "D:\\x", isExact: true });
    expect(windowsBashOperandPath("/d/x", cwd, "cygwin")).toStrictEqual({ path: "D:\\x", isExact: false });
    expect(windowsBashOperandPath("C:/Users/me/x", cwd, "msys")).toStrictEqual({ path: "C:\\Users\\me\\x", isExact: true });
    // An unidentified shell may be MSYS: its drive paths are protection-only.
    expect(windowsBashOperandPath("/c/Users", cwd, "unknown")).toStrictEqual({ path: "C:\\Users", isExact: false });
    expect(windowsBashOperandPath("C:\\Users", cwd, "unknown")).toStrictEqual({ path: "C:\\Users", isExact: false });
    expect(windowsBashOperandPath("src/a.ts", cwd, "wsl")).toStrictEqual({ path: `${cwd}\\src\\a.ts`, isExact: true });
    for (const [operand, flavor] of [
        ["/tmp/x", "msys"],
        ["/", "msys"],
        ["/usr/bin", "cygwin"],
        ["//server/share", "msys"],
        ["/mnt/c/Users", "wsl"],
        ["/c/Users", "wsl"],
        ["C:\\Users", "wsl"],
        ["/tmp/x", "unknown"],
        ["C:Users", "msys"],
        ["\\Users", "msys"],
    ])
        expect(windowsBashOperandPath(operand, cwd, flavor), `${flavor} ${operand}`).toBeUndefined();
});

test("[windows-paths] file tools mirror Pi's Windows drive and home normalization", () => {
    expect(normalizeToolPathInput("/c/Users/me/x", "C:\\Users\\me", "win32")).toBe("C:\\Users\\me\\x");
    expect(normalizeToolPathInput("/mnt/d/data", "C:\\Users\\me", "win32")).toBe("D:\\data");
    expect(normalizeToolPathInput("/cygdrive/e", "C:\\Users\\me", "win32")).toBe("E:\\");
    expect(normalizeToolPathInput("~\\.pi\\x", "C:\\Users\\me", "win32")).toBe("C:\\Users\\me\\.pi\\x");
    expect(normalizeToolPathInput("@/tmp/x", "C:\\Users\\me", "win32")).toBe("/tmp/x");
    expect(normalizeToolPathInput("/c/x", "/home/me", "linux")).toBe("/c/x");
    expect(normalizeToolPathInput("~\\x", "/home/me", "linux")).toBe("~\\x");
});

test("[windows-paths] remote UNC paths resolve lexically without touching the file system", async () => {
    const calls = [];
    const host = {
        platform: "win32",
        realpath: async (path) => {
            calls.push(["realpath", path]);
            return path;
        },
        access: async (path) => {
            calls.push(["access", path]);
        },
        hostname: () => "WORKSTATION",
    };
    for (const path of ["\\\\srv\\share\\x", "//srv/share/x", "\\\\srv.example.com\\data"])
        expect(isRemoteWindowsPath(path, "win32"), path).toBe(true);
    for (const path of ["C:\\x", "\\x", "\\\\?\\C:\\x", "\\\\.\\pipe\\x", "relative"])
        expect(isRemoteWindowsPath(path, "win32"), path).toBe(false);
    expect(isRemoteWindowsPath("//srv/share/x", "linux")).toBe(false);
    expect(await canonicalPath("\\\\srv\\share\\a\\..\\b.txt", "C:\\repo", host)).toBe("\\\\srv\\share\\b.txt");
    expect(await canonicalPath("x.txt", "\\\\srv\\share\\repo", host)).toBe("\\\\srv\\share\\repo\\x.txt");
    expect(await resolveToolPath("//srv/share/notes.txt", "C:\\repo", true, "C:\\Users\\me", host)).toBe("\\\\srv\\share\\notes.txt");
    expect(await resolveToolPath("file://srv/share/notes.txt", "C:\\repo", true, "C:\\Users\\me", host)).toBe("\\\\srv\\share\\notes.txt");
    expect(calls).toStrictEqual([]);
    // Loopback, own-host and administrative shares still fail closed, also without file-system access.
    for (const path of ["\\\\localhost\\share\\x", "\\\\workstation\\share\\x", "\\\\srv\\C$\\x"])
        await expect(canonicalPath(path, "C:\\repo", host), path).rejects.toThrow(
            expect.objectContaining({ code: "INVALID_PATH" }),
        );
    expect(calls).toStrictEqual([]);
    // Local paths still resolve through the injected file system.
    expect(await canonicalPath("x.txt", "C:\\repo", host)).toBe("C:\\repo\\x.txt");
    expect(calls).toStrictEqual([["realpath", "C:\\repo\\x.txt"]]);
});

test("[windows-paths] executable identity and temporary roots follow the host platform", () => {
    expect(commandName("C:\\Program Files\\Git\\bin\\BASH.EXE", "win32")).toBe("bash");
    expect(commandName("/usr/bin/Bash.exe", "linux")).toBe("Bash.exe");
    expect(defaultShellIdentity("bash", "win32")).toBe("pi-default-shell-unresolved");
    expect(defaultShellIdentity("bash", "linux")).toBe("/bin/bash");
    expect(defaultShellIdentity("powershell", "linux")).toBe("pi-default-shell-unresolved");
    expect(ruleCommands("BASH.EXE -c 'git push'", "C:\\Git\\bin\\bash.exe", 0, "win32")).toStrictEqual([["git", "push"]]);
    expect(ruleCommands("bash.exe -c 'git push'", "/bin/bash", 0, "linux")).toStrictEqual([["bash.exe", "-c", "git push"]]);
    const settings = { excludeSlashTmp: false, excludeTmpdir: false };
    expect(defaultTemporaryRoots(settings, "win32", "C:\\Temp")).toStrictEqual(["C:\\Temp"]);
    expect(defaultTemporaryRoots(settings, "linux", "/var/tmp")).toStrictEqual(["/tmp", "/var/tmp"]);
    expect(defaultTemporaryRoots({ ...settings, excludeSlashTmp: true }, "linux", "/var/tmp")).toStrictEqual(["/var/tmp"]);
    expect(defaultTemporaryRoots({ ...settings, excludeTmpdir: true }, "win32", "C:\\Temp")).toStrictEqual([]);
});

test("[paths] a differently spelled missing protected component cannot alias it on case-insensitive hosts", async (t) => {
    const f = await fixture(t);
    const settings = validateSettings({});
    const guard = join(f.workspace, "agent", "guard", "settings.json");
    const profile = await defaultProfile(f.workspace, settings, [guard]);
    const policy = new PolicyEngine(settings, profile);
    const evaluate = (tool, args) =>
        policy.evaluate(
            createAction(
                {
                    toolCallId: "call",
                    tool,
                    args,
                    source: "model",
                    cwd: f.workspace,
                    sessionId: "session",
                    policyRevision: policy.revision,
                },
                profile,
            ),
        );
    const folds = process.platform === "darwin" || process.platform === "win32";
    for (const [tool, args] of [
        ["write", { path: "AGENT/Guard/settings.json", content: "x" }],
        ["bash", { command: "touch AGENT/Guard/SETTINGS.json" }],
    ])
        expect((await evaluate(tool, args)).kind, tool).toBe(folds ? "deny" : "allow");
});

test("[paths] gitdir pointers written with CRLF still protect the linked worktree metadata", async (t) => {
    const f = await fixture(t);
    const metadata = join(f.root, "main", ".git", "worktrees", "linked");
    await mkdir(metadata, { recursive: true });
    await writeFile(join(f.workspace, ".git"), `gitdir: ${metadata}\r\n`);
    const settings = validateSettings({});
    const profile = await defaultProfile(f.workspace, settings);
    expect(profile.readOnlyPaths).toContain(await canonicalPath(metadata, f.workspace));
    const policy = new PolicyEngine(settings, profile);
    const result = await policy.evaluate(
        createAction(
            {
                toolCallId: "call",
                tool: "bash",
                args: { command: "git commit -m x" },
                source: "model",
                cwd: f.workspace,
                sessionId: "session",
                policyRevision: policy.revision,
            },
            profile,
        ),
    );
    expect(result.delta.writePaths).toContain(await canonicalPath(metadata, f.workspace));
});

test.runIf(process.platform === "win32")("[windows] canonical paths fail closed for Windows aliases of protected files", async (t) => {
    const f = await fixture(t);
    const protectedFile = join(f.control, "protected.txt");
    for (const path of [
        `${protectedFile}:stream`,
        `${protectedFile}::$DATA`,
        `\\\\?\\${protectedFile}`,
        join(f.control, "NUL"),
        join(f.control, "missing.json."),
        join(f.control, "MISSIN~1.JSO"),
        `${f.control.slice(0, 2)}relative`,
    ])
        await expect(canonicalPath(path, f.workspace), path).rejects.toThrow(
            expect.objectContaining({ code: "INVALID_PATH" }),
        );
    // A trailing-dot spelling of an existing protected file either resolves to it or fails closed.
    const trailing = await canonicalPath(`${protectedFile}.`, f.workspace).catch((error) => error);
    if (typeof trailing === "string") expect(trailing).toBe(await canonicalPath(protectedFile, f.workspace));
    else expect(trailing.code).toBe("INVALID_PATH");
});

test.runIf(process.platform === "win32")("[windows] remote UNC targets are reviewed as unbound without resolution", async (t) => {
    const f = await fixture(t);
    const policy = new PolicyEngine(validateSettings({}), f.profile);
    const evaluate = (tool, args) =>
        policy.evaluate(
            createAction(
                {
                    toolCallId: "call",
                    tool,
                    args,
                    source: "model",
                    cwd: f.workspace,
                    sessionId: "session",
                    policyRevision: policy.revision,
                },
                f.profile,
            ),
        );
    expect(await evaluate("write", { path: "\\\\pi-unc-fixture.invalid\\share\\x.txt", content: "x" })).toMatchObject({
        kind: "ask",
        delta: { readPaths: [], writePaths: [], domains: [] },
        unboundTargets: ["write"],
    });
    expect(await evaluate("read", { path: "//pi-unc-fixture.invalid/share/x.txt" })).toMatchObject({
        kind: "ask",
        unboundTargets: ["read"],
    });
    expect(await evaluate("powershell", { command: "Get-Content \\\\pi-unc-fixture.invalid\\share\\x.txt" })).toMatchObject({
        kind: "ask",
        unboundTargets: ["read"],
    });
});

test.runIf(process.platform === "win32")("[windows] trusted allow rules do not authorize WSL or MSYS targets without a Windows location", async (t) => {
    const f = await fixture(t);
    const policy = new PolicyEngine(
        validateSettings({ commandRules: [{ prefix: ["cp"], decision: "allow" }] }),
        f.profile,
    );
    const evaluate = (command, shellPath) =>
        policy.evaluate(
            createAction(
                {
                    toolCallId: "call",
                    tool: "bash",
                    args: { command, shellPath },
                    source: "model",
                    cwd: f.workspace,
                    sessionId: "session",
                    policyRevision: policy.revision,
                },
                f.profile,
            ),
        );
    for (const [command, shellPath] of [
        ["cp a.txt /mnt/c/x", "C:\\Windows\\System32\\bash.exe"],
        ["cp a.txt /etc/x", "C:\\Program Files\\Git\\bin\\bash.exe"],
    ]) {
        const result = await evaluate(command, shellPath);
        expect(result.kind, command).toBe("ask");
        expect(result.authority, command).toBeUndefined();
        expect(result.unboundTargets, command).toStrictEqual(["write"]);
    }
    expect(await evaluate("cp a.txt b.txt", "C:\\Windows\\System32\\bash.exe")).toMatchObject({
        kind: "allow",
        authority: { kind: "command-rule" },
    });
});

test.runIf(process.platform === "win32")("[windows] Git Bash drive paths reach deny checks and unknown POSIX roots need review", async (t) => {
    const f = await fixture(t);
    const settings = validateSettings({});
    const policy = new PolicyEngine(settings, f.profile);
    const evaluate = (command, shellPath) =>
        policy.evaluate(
            createAction(
                {
                    toolCallId: "call",
                    tool: "bash",
                    args: { command, shellPath },
                    source: "model",
                    cwd: f.workspace,
                    sessionId: "session",
                    policyRevision: policy.revision,
                },
                f.profile,
            ),
        );
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const msys = `/${f.control[0].toLowerCase()}${f.control.slice(2).replaceAll("\\", "/")}/protected.txt`;
    expect((await evaluate(`rm '${msys}'`, gitBash)).kind).toBe("deny");
    expect((await evaluate(`cat '${msys}'`, gitBash)).kind).toBe("deny");
    expect((await evaluate("rm /tmp/x", gitBash)).kind).toBe("ask");
    expect((await evaluate(`rm '${msys}'`, "C:\\Windows\\System32\\bash.exe")).kind).toBe("ask");
    expect((await evaluate("touch notes.txt", gitBash)).kind).toBe("allow");
});
