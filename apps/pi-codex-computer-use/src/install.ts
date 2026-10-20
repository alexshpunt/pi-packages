import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { browserPrerequisiteChecks } from "./browser-checks.js";
import {
    describePlatform,
    detectPlatform,
    type PlatformInfo,
    resolveCodexHome,
} from "./platform.js";
import {
    discoverRuntime,
    locateServiceApp,
    type RuntimeDiscovery,
    type RuntimePlan,
    readRuntimeManifest,
} from "./runtime.js";

const execFileAsync = promisify(execFile);

/**
 * `ok`/`missing`: verified on this machine. `unverified`: implemented from documentation, not
 * exercised on this platform. `user-owned`: only the user can satisfy it. `skipped`: not applicable.
 */
export type CheckStatus =
    | "ok"
    | "missing"
    | "unverified"
    | "user-owned"
    | "skipped";

export interface PrerequisiteCheck {
    id: string;
    label: string;
    status: CheckStatus;
    detail: string;
    /** What the user should do; the package never performs these steps itself. */
    action?: string;
}

export interface SetupScriptResult {
    command: string;
    args: string[];
    exitCode: number | null;
    signal: string | null;
    outputTail: string;
    durationMs: number;
}

export interface PrerequisiteReport {
    platform: PlatformInfo;
    runtime: RuntimeDiscovery;
    checks: PrerequisiteCheck[];
    setupScript?: SetupScriptResult;
    piVersion: string;
}

export interface PrerequisiteOptions {
    env?: NodeJS.ProcessEnv;
    /** Run Codex's own `setup.sh` / `setup.ps1` validation (default true). */
    runSetupScript?: boolean;
    setupTimeoutMs?: number;
}

const MINIMUM_PI_VERSION = "1.0.0";
const CHROME_NATIVE_HOST_NAME = "com.openai.codexextension";
const OAI_PACKAGES = ["cua-repl", "cua", "sky", "browser-desktop"];
const OUTPUT_TAIL_LIMIT = 1_500;
/** `setup.sh` on the 26.930 macOS build asserts launchers (`bin/npm`, `bin/npx`) the app does not ship. */
const MISSING_LAUNCHER_PATTERN =
    /missing file path=.*[\\/]bin[\\/](npm|npx|corepack)(\.cmd)?\s*$/m;

async function isFile(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

function platformCheck(platform: PlatformInfo): PrerequisiteCheck {
    if (!platform.supported)
        return {
            id: "platform",
            label: "Platform",
            status: "missing",
            detail: describePlatform(platform),
            action: "Use macOS or Windows.",
        };
    return {
        id: "platform",
        label: "Platform",
        status: platform.verification === "verified" ? "ok" : "unverified",
        detail: describePlatform(platform),
    };
}

function desktopAppCheck(runtime: RuntimeDiscovery): PrerequisiteCheck {
    const base = { id: "codex-desktop-app", label: "Codex Desktop app" };
    if (runtime.kind === "plan") {
        const location =
            runtime.appPath ??
            (runtime.configPath
                ? `runtime referenced by ${runtime.configPath}`
                : runtime.command);
        const version = runtime.appVersion ? ` ${runtime.appVersion}` : "";
        return {
            ...base,
            status: runtime.isSimulated ? "unverified" : "ok",
            detail: `${location}${version}`,
        };
    }
    if (runtime.reason === "platform-unsupported")
        return { ...base, status: "skipped", detail: "Unsupported platform." };
    return { ...base, status: "missing", detail: runtime.message };
}

async function runtimeFilesCheck(
    plan: RuntimePlan | undefined,
): Promise<PrerequisiteCheck> {
    const base = { id: "runtime", label: "Computer Use runtime (cua_node)" };
    if (!plan)
        return {
            ...base,
            status: "missing",
            detail: "Not found.",
        };
    if (plan.isSimulated || !plan.nodeModules || !plan.runtimeRoot)
        return {
            ...base,
            status: "unverified",
            detail: "Not checked for a simulated platform.",
        };
    const versions: string[] = [];
    const missing: string[] = [];
    for (const name of OAI_PACKAGES) {
        const packageJson = join(
            plan.nodeModules,
            "@oai",
            name,
            "package.json",
        );
        try {
            const parsed = JSON.parse(await readFile(packageJson, "utf8")) as {
                version?: unknown;
            };
            versions.push(
                `@oai/${name} ${typeof parsed.version === "string" ? parsed.version : "?"}`,
            );
        } catch {
            missing.push(`@oai/${name}`);
        }
    }
    if (!(await isFile(join(plan.runtimeRoot, "manifest.json"))))
        missing.push("manifest.json");
    if (missing.length > 0)
        return {
            ...base,
            status: "missing",
            detail: `${plan.runtimeRoot} lacks ${missing.join(", ")}.`,
            action: "Update or reinstall Codex Desktop.",
        };
    return {
        ...base,
        status: "ok",
        detail: `${plan.runtimeRoot}: ${versions.join(", ")}`,
    };
}

async function runSetupScript(
    plan: RuntimePlan,
    platform: PlatformInfo & { supported: true },
    timeoutMs: number,
): Promise<{ check: PrerequisiteCheck; result?: SetupScriptResult }> {
    const base = {
        id: "setup-script",
        label: "Codex setup script",
    };
    if (plan.isSimulated || !plan.runtimeRoot)
        return {
            check: {
                ...base,
                status: "skipped",
                detail: "Not run for a simulated platform.",
            },
        };
    const isWindows = platform.platform === "win32";
    const script = join(
        plan.runtimeRoot,
        "bin",
        isWindows ? "setup.ps1" : "setup.sh",
    );
    if (!(await isFile(script)))
        return {
            check: {
                ...base,
                status: "missing",
                detail: `${script} does not exist.`,
            },
        };
    const command = isWindows ? "powershell" : "bash";
    const args = isWindows
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
        : [script];
    const startedAt = Date.now();
    let exitCode: number | null = 0;
    let signal: string | null = null;
    let output = "";
    try {
        const { stdout, stderr } = await execFileAsync(command, args, {
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
        });
        output = `${stdout}${stderr}`;
    } catch (error) {
        const failure = error as NodeJS.ErrnoException & {
            stdout?: string;
            stderr?: string;
            signal?: string;
            code?: number | string;
        };
        exitCode = typeof failure.code === "number" ? failure.code : null;
        signal = failure.signal ?? null;
        output = `${failure.stdout ?? ""}${failure.stderr ?? ""}${
            typeof failure.code === "string" ? `\n${failure.message}` : ""
        }`;
    }
    const outputTail = output.trim().slice(-OUTPUT_TAIL_LIMIT);
    const result: SetupScriptResult = {
        command,
        args,
        exitCode,
        signal,
        outputTail,
        durationMs: Date.now() - startedAt,
    };
    const passed = exitCode === 0 && signal === null;
    if (passed)
        return {
            check: {
                ...base,
                status: "ok",
                detail: outputTail || `${command} ${script} exited 0`,
            },
            result,
        };
    const failure = `${command} ${script} failed (exit ${exitCode ?? "?"}${signal ? `, signal ${signal}` : ""}): ${outputTail}`;
    const missingLauncher = MISSING_LAUNCHER_PATTERN.exec(outputTail);
    if (missingLauncher)
        return {
            check: {
                ...base,
                status: "unverified",
                detail: `Stops at missing bin/${missingLauncher[1]}, which this Codex Desktop build does not include. The runtime check below covers the rest.`,
            },
            result,
        };
    return {
        check: {
            ...base,
            status: "missing",
            detail: failure,
            action: "Update or reinstall Codex Desktop so its runtime validation passes.",
        },
        result,
    };
}

async function runCommand(
    command: string,
    args: string[],
    options: { cwd?: string; timeoutMs: number },
): Promise<{ ok: boolean; output: string }> {
    try {
        const { stdout, stderr } = await execFileAsync(command, args, {
            cwd: options.cwd,
            timeout: options.timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
        });
        return { ok: true, output: `${stdout}${stderr}`.trim() };
    } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        return {
            ok: false,
            output:
                `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() ||
                failure.message,
        };
    }
}

/**
 * The checks `setup.sh` performs that matter for running `cua_repl`: the bundled Node reports the
 * manifest version, `@oai/sky` imports from the runtime's `node_modules`, and `node_repl --help`
 * exits 0. Uses a temporary directory outside CODEX_HOME for the import, like the script does.
 */
async function runtimeValidationCheck(
    plan: RuntimePlan,
    platform: PlatformInfo & { supported: true },
    timeoutMs: number,
): Promise<PrerequisiteCheck> {
    const base = {
        id: "runtime-validation",
        label: "Runtime check",
    };
    if (plan.isSimulated || !plan.runtimeRoot || !plan.nodeModules)
        return {
            ...base,
            status: "skipped",
            detail: "Not run for a simulated platform.",
        };
    const manifest = await readRuntimeManifest(
        join(plan.runtimeRoot, "manifest.json"),
    );
    if (!manifest)
        return {
            ...base,
            status: "missing",
            detail: `${join(plan.runtimeRoot, "manifest.json")} is unreadable.`,
            action: "Update or reinstall Codex Desktop.",
        };
    const nodePath = join(plan.runtimeRoot, manifest.nodePath);
    const nodeReplPath = join(plan.runtimeRoot, manifest.nodeReplPath);
    const problems: string[] = [];
    const passed: string[] = [];
    const version = await runCommand(nodePath, ["--version"], { timeoutMs });
    if (!version.ok) problems.push(`node --version failed: ${version.output}`);
    else if (
        manifest.nodeBinaryVersion &&
        version.output !== `v${manifest.nodeBinaryVersion}`
    )
        problems.push(
            `node reports ${version.output}, manifest expects v${manifest.nodeBinaryVersion}`,
        );
    else passed.push(`node ${version.output}`);
    const importDir = await mkdtemp(join(tmpdir(), "pi-codex-computer-use-"));
    try {
        await symlink(
            plan.nodeModules,
            join(importDir, "node_modules"),
            platform.platform === "win32" ? "junction" : "dir",
        );
        const imported = await runCommand(
            nodePath,
            [
                "--input-type=module",
                "--eval",
                'const imported = await import("@oai/sky"); if (!imported.sky) throw new Error("@oai/sky missing sky export");',
            ],
            { cwd: importDir, timeoutMs },
        );
        if (imported.ok) passed.push("@oai/sky imports");
        else
            problems.push(
                `@oai/sky import failed: ${imported.output.slice(-300)}`,
            );
    } finally {
        await rm(importDir, { recursive: true, force: true });
    }
    const help = await runCommand(nodeReplPath, ["--help"], { timeoutMs });
    if (help.ok) passed.push("node_repl --help exits 0");
    else problems.push(`node_repl --help failed: ${help.output.slice(-300)}`);
    if (problems.length > 0)
        return {
            ...base,
            status: "missing",
            detail: problems.join("; "),
            action: "Update or reinstall Codex Desktop.",
        };
    return { ...base, status: "ok", detail: passed.join(", ") };
}

function launchConfigCheck(runtime: RuntimeDiscovery): PrerequisiteCheck {
    const base = {
        id: "mcp-config",
        label: "Launch config (.mcp.json)",
    };
    if (runtime.kind === "plan" && runtime.source === "plugin-cache")
        return {
            ...base,
            status: "ok",
            detail: runtime.configPath ?? runtime.command,
        };
    if (runtime.kind === "plan")
        return {
            ...base,
            status: "unverified",
            detail: `Not found under ${runtime.codexHome}. Using the app bundle at ${runtime.appPath ?? runtime.runtimeRoot}; first launch this way is untested.`,
            action: "Turn on Computer Use once in Codex Desktop.",
        };
    if (runtime.reason === "platform-unsupported")
        return { ...base, status: "skipped", detail: "Unsupported platform." };
    return { ...base, status: "missing", detail: "Not found." };
}

async function serviceCheck(
    plan: RuntimePlan | undefined,
    platform: PlatformInfo,
    env: NodeJS.ProcessEnv,
): Promise<PrerequisiteCheck> {
    const base = { id: "service-app", label: "Computer Use native service" };
    if (!platform.supported)
        return { ...base, status: "skipped", detail: "Unsupported platform." };
    if (platform.isSimulated)
        return {
            ...base,
            status: "unverified",
            detail: "Not checked for a simulated platform.",
        };
    if (platform.platform === "win32") {
        if (!plan?.nodeModules)
            return {
                ...base,
                status: "missing",
                detail: "The Windows helper lives in @oai/sky, which was not found.",
            };
        const helper = join(
            plan.nodeModules,
            "@oai",
            "sky",
            "bin",
            "windows",
            process.arch === "arm64"
                ? "codex-computer-use-arm64.exe"
                : "codex-computer-use.exe",
        );
        return (await isFile(helper))
            ? {
                  ...base,
                  status: "unverified",
                  detail: `${helper} (untested on Windows)`,
              }
            : {
                  ...base,
                  status: "missing",
                  detail: `${helper} does not exist.`,
                  action: "Update or reinstall Codex Desktop.",
              };
    }
    const codexHome = plan?.codexHome ?? resolveCodexHome(platform, env);
    const location = await locateServiceApp({
        codexHome,
        nodeModules: plan?.nodeModules,
        env,
    });
    if (!location)
        return {
            ...base,
            status: "missing",
            detail: `Codex Computer Use.app not found via SKY_CUA_SERVICE_PATH, ${join(codexHome, "computer-use")}, or the app bundle.`,
            action: "Turn on Computer Use once in Codex Desktop.",
        };
    const sourceLabel = {
        env: "SKY_CUA_SERVICE_PATH",
        "codex-home": "Codex Desktop install",
        "app-bundle": "app bundle copy, untested from pi",
    }[location.source];
    return {
        ...base,
        status: location.source === "app-bundle" ? "unverified" : "ok",
        detail: `${location.path} (${sourceLabel})`,
        ...(location.source === "app-bundle"
            ? {
                  action: "Turn on Computer Use once in Codex Desktop.",
              }
            : {}),
    };
}

function permissionsCheck(platform: PlatformInfo): PrerequisiteCheck {
    const base = {
        id: "os-permissions",
        label: "OS permissions",
    };
    if (!platform.supported)
        return { ...base, status: "skipped", detail: "Unsupported platform." };
    if (platform.platform === "darwin")
        return {
            ...base,
            status: "user-owned",
            detail: "Allow Accessibility and Screen Recording for Codex Computer Use.app (System Settings → Privacy & Security).",
        };
    return {
        ...base,
        status: "user-owned",
        detail: "Allow any Windows prompt on first use.",
    };
}

async function chromeNativeHostCheck(
    platform: PlatformInfo,
): Promise<{ check: PrerequisiteCheck; allowedExtensionIds: string[] }> {
    const base = {
        id: "chrome-native-host",
        label: "Browser Use: native messaging host",
    };
    if (!platform.supported)
        return {
            check: {
                ...base,
                status: "skipped",
                detail: "Unsupported platform.",
            },
            allowedExtensionIds: [],
        };
    if (platform.isSimulated)
        return {
            check: {
                ...base,
                status: "unverified",
                detail: "Not checked for a simulated platform.",
            },
            allowedExtensionIds: [],
        };
    const action = "Turn on the Chrome plugin in Codex Desktop.";
    if (platform.platform === "win32") {
        try {
            await execFileAsync(
                "reg",
                [
                    "query",
                    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${CHROME_NATIVE_HOST_NAME}`,
                    "/ve",
                ],
                { timeout: 5_000, windowsHide: true },
            );
            return {
                check: {
                    ...base,
                    status: "unverified",
                    detail: `${CHROME_NATIVE_HOST_NAME} registered in HKCU (untested on Windows)`,
                },
                allowedExtensionIds: [],
            };
        } catch {
            return {
                check: {
                    ...base,
                    status: "missing",
                    detail: `${CHROME_NATIVE_HOST_NAME} is not registered under HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts.`,
                    action,
                },
                allowedExtensionIds: [],
            };
        }
    }
    const manifestPath = join(
        homedir(),
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "NativeMessagingHosts",
        `${CHROME_NATIVE_HOST_NAME}.json`,
    );
    try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
            path?: unknown;
            allowed_origins?: unknown;
        };
        const allowedExtensionIds = Array.isArray(manifest.allowed_origins)
            ? manifest.allowed_origins
                  .filter(
                      (origin): origin is string => typeof origin === "string",
                  )
                  .map((origin) =>
                      origin
                          .replace(/^chrome-extension:\/\//, "")
                          .replace(/\/$/, ""),
                  )
            : [];
        const hostPath =
            typeof manifest.path === "string" ? manifest.path : undefined;
        if (!hostPath || !(await isFile(hostPath)))
            return {
                check: {
                    ...base,
                    status: "missing",
                    detail: `${manifestPath} points at ${hostPath ?? "no executable"}, which does not exist.`,
                    action,
                },
                allowedExtensionIds,
            };
        return {
            check: {
                ...base,
                status: "ok",
                detail: `${manifestPath} → ${hostPath}`,
            },
            allowedExtensionIds,
        };
    } catch {
        return {
            check: {
                ...base,
                status: "missing",
                detail: `${manifestPath} does not exist.`,
                action,
            },
            allowedExtensionIds: [],
        };
    }
}

function parseVersion(version: string): number[] {
    return version
        .split("-")[0]
        .split(".")
        .map((segment) => Number.parseInt(segment, 10) || 0);
}

function isAtLeast(version: string, minimum: string): boolean {
    const actual = parseVersion(version);
    const required = parseVersion(minimum);
    for (
        let index = 0;
        index < Math.max(actual.length, required.length);
        index += 1
    ) {
        const a = actual[index] ?? 0;
        const b = required[index] ?? 0;
        if (a !== b) return a > b;
    }
    return true;
}

function piVersionCheck(): PrerequisiteCheck {
    const base = { id: "pi-version", label: "pi version" };
    return isAtLeast(PI_VERSION, MINIMUM_PI_VERSION)
        ? { ...base, status: "ok", detail: `pi ${PI_VERSION}` }
        : {
              ...base,
              status: "missing",
              detail: `pi ${PI_VERSION} is older than ${MINIMUM_PI_VERSION}.`,
              action: "Update pi (`pi update self`).",
          };
}

/** Read-only checks plus Codex's own runtime validation script. Never writes under CODEX_HOME. */
export async function checkPrerequisites(
    options: PrerequisiteOptions = {},
): Promise<PrerequisiteReport> {
    const env = options.env ?? process.env;
    const platform = detectPlatform(env);
    const runtime = await discoverRuntime({ env, platform });
    const plan = runtime.kind === "plan" ? runtime : undefined;
    const checks: PrerequisiteCheck[] = [
        platformCheck(platform),
        {
            id: "codex-subscription",
            label: "Codex subscription",
            status: "user-owned",
            detail: "Requires a ChatGPT plan that includes Codex.",
        },
        {
            id: "codex-login",
            label: "Codex Desktop login",
            status: "user-owned",
            detail: "Sign in inside Codex Desktop.",
        },
        desktopAppCheck(runtime),
        await runtimeFilesCheck(plan),
    ];
    let setupScript: SetupScriptResult | undefined;
    if (plan && platform.supported) {
        if (options.runSetupScript === false)
            checks.push({
                id: "setup-script",
                label: "Codex setup script",
                status: "skipped",
                detail: "Not run.",
            });
        else {
            const timeoutMs = options.setupTimeoutMs ?? 60_000;
            const outcome = await runSetupScript(plan, platform, timeoutMs);
            checks.push(outcome.check);
            setupScript = outcome.result;
            checks.push(
                await runtimeValidationCheck(plan, platform, timeoutMs),
            );
        }
    }
    checks.push(launchConfigCheck(runtime));
    checks.push(await serviceCheck(plan, platform, env));
    checks.push(permissionsCheck(platform));
    // Browser Use: prefer Codex Desktop's own Chrome diagnostics scripts; fall back to file checks.
    const codexHome = plan?.codexHome ?? resolveCodexHome(platform, env);
    const browser = await browserPrerequisiteChecks({
        codexHome,
        platform,
        env,
        nodePath: plan?.command,
    });
    if (browser.checks.length > 0) checks.push(...browser.checks);
    else {
        const chrome = await chromeNativeHostCheck(platform);
        checks.push({
            id: "browser-installed",
            label: "Browser Use: Chrome plugin",
            status: platform.supported ? "missing" : "skipped",
            detail: `Not found under ${join(codexHome, "plugins", "cache", "openai-bundled", "chrome")}.`,
            action: "Turn on the Chrome plugin in Codex Desktop.",
        });
        checks.push(chrome.check);
        checks.push({
            id: "chrome-extension",
            label: "Browser Use: ChatGPT extension",
            status: "user-owned",
            detail:
                chrome.allowedExtensionIds.length > 0
                    ? `Install the ChatGPT extension in Chrome (ID ${chrome.allowedExtensionIds.join(" or ")}).`
                    : "Install the ChatGPT extension in Chrome.",
        });
    }
    checks.push(piVersionCheck());
    return { platform, runtime, checks, setupScript, piVersion: PI_VERSION };
}

const STATUS_TAGS: Record<CheckStatus, string> = {
    ok: "ok        ",
    missing: "MISSING   ",
    unverified: "unverified",
    "user-owned": "user-owned",
    skipped: "skipped   ",
};

export function formatPrerequisiteReport(report: PrerequisiteReport): string[] {
    const lines: string[] = [];
    for (const check of report.checks) {
        lines.push(
            `[${STATUS_TAGS[check.status]}] ${check.label}: ${check.detail}`,
        );
        if (check.action) lines.push(`             → ${check.action}`);
    }
    return lines;
}

/** First-time setup steps shown after the prerequisite report. */
export function formatSetupGuide(report: PrerequisiteReport): string[] {
    if (!report.platform.supported)
        return [
            `${report.platform.label} is not supported. Computer Use requires Codex Desktop on macOS or Windows.`,
        ];
    return [
        "First-time setup",
        "1. Install Codex Desktop (the Codex CLI alone is not enough) and sign in with a ChatGPT plan that includes Codex.",
        report.platform.platform === "darwin"
            ? "2. Computer Use: turn it on once in Codex Desktop, then allow Accessibility and Screen Recording for Codex Computer Use.app."
            : "2. Computer Use: turn it on once in Codex Desktop and allow any Windows prompt.",
        "3. Browser Use: install Chrome and the ChatGPT extension, then turn on the Chrome plugin in Codex Desktop.",
        "4. Run /computer-use-check again, then choose features in /computer-use.",
    ];
}
