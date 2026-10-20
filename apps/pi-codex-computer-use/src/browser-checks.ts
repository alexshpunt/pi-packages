import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PrerequisiteCheck } from "./install.js";
import type { PlatformInfo } from "./platform.js";
import { compareVersionsDesc, readBundleInfo } from "./runtime.js";

const execFileAsync = promisify(execFile);

/*
 * Browser Use (Chrome backend) prerequisites, checked with the diagnostics scripts Codex Desktop
 * installs with its Chrome plugin (`plugins/cache/openai-bundled/chrome/<version>/scripts`). The
 * scripts are read-only and documented in that plugin's docs/chrome-troubleshooting.md; the package
 * never installs or repairs anything they report.
 */

export const BROWSER_FAMILY = "chrome";
const SCRIPT_TIMEOUT_MS = 15_000;

export interface ChromeDiagnostics {
    pluginVersion: string;
    scriptsDir: string;
    storeUrl?: string;
    extensionIds: string[];
}

async function isFile(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Where Google Chrome normally lives. The runtime's `installed-browsers.js` answers the same question
 * through LaunchServices but takes ~17 s on this Mac, too slow for a status command.
 */
async function findChromeInstall(
    platform: PlatformInfo,
    env: NodeJS.ProcessEnv,
): Promise<{ path: string; version?: string } | undefined> {
    if (!platform.supported) return undefined;
    if (platform.platform === "darwin") {
        for (const appPath of [
            "/Applications/Google Chrome.app",
            join(homedir(), "Applications", "Google Chrome.app"),
        ])
            if (await isDirectory(appPath))
                return {
                    path: appPath,
                    version: (await readBundleInfo(appPath)).version,
                };
        return undefined;
    }
    const roots = [
        env.PROGRAMFILES,
        env["PROGRAMFILES(X86)"],
        env.LOCALAPPDATA,
    ].filter(
        (root): root is string => typeof root === "string" && root.length > 0,
    );
    for (const root of roots) {
        const exe = join(root, "Google", "Chrome", "Application", "chrome.exe");
        if (await isFile(exe)) return { path: exe };
    }
    return undefined;
}

/** Newest Chrome plugin version under CODEX_HOME that ships the diagnostics scripts. */
export async function locateChromeDiagnostics(
    codexHome: string,
): Promise<ChromeDiagnostics | undefined> {
    const root = join(
        codexHome,
        "plugins",
        "cache",
        "openai-bundled",
        "chrome",
    );
    let versions: string[];
    try {
        versions = (await readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && entry.name !== "latest")
            .map((entry) => entry.name)
            .sort(compareVersionsDesc);
    } catch {
        return undefined;
    }
    for (const version of versions) {
        const scriptsDir = join(root, version, "scripts");
        if (!(await isFile(join(scriptsDir, "check-extension-installed.js"))))
            continue;
        let storeUrl: string | undefined;
        let extensionIds: string[] = [];
        try {
            const config = JSON.parse(
                await readFile(join(scriptsDir, "extension-ids.json"), "utf8"),
            ) as { browserExtensions?: unknown };
            const entry = Array.isArray(config.browserExtensions)
                ? (config.browserExtensions as Record<string, unknown>[]).find(
                      (candidate) => candidate.browserFamily === BROWSER_FAMILY,
                  )
                : undefined;
            if (entry) {
                if (typeof entry.storeUrl === "string")
                    storeUrl = entry.storeUrl;
                if (Array.isArray(entry.extensionIds))
                    extensionIds = entry.extensionIds.filter(
                        (id): id is string => typeof id === "string",
                    );
            }
        } catch {
            // The checks still work without the catalog.
        }
        return { pluginVersion: version, scriptsDir, storeUrl, extensionIds };
    }
    return undefined;
}

interface ScriptRun {
    exitCode: number | null;
    json: Record<string, unknown> | undefined;
    output: string;
}

async function runDiagnostic(
    diagnostics: ChromeDiagnostics,
    script: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    nodePath = process.execPath,
): Promise<ScriptRun> {
    const scriptPath = join(diagnostics.scriptsDir, script);
    let exitCode: number | null = 0;
    let output = "";
    try {
        const { stdout, stderr } = await execFileAsync(
            nodePath,
            [scriptPath, ...args],
            {
                cwd: diagnostics.scriptsDir,
                env,
                timeout: SCRIPT_TIMEOUT_MS,
                maxBuffer: 2 * 1024 * 1024,
                windowsHide: true,
            },
        );
        output = stdout || stderr;
    } catch (error) {
        const failure = error as Error & {
            code?: number | string;
            stdout?: string;
            stderr?: string;
        };
        exitCode = typeof failure.code === "number" ? failure.code : null;
        output = failure.stdout || failure.stderr || failure.message;
    }
    let json: Record<string, unknown> | undefined;
    try {
        const parsed: unknown = JSON.parse(output);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
        )
            json = parsed as Record<string, unknown>;
    } catch {
        json = undefined;
    }
    return { exitCode, json, output: output.trim().slice(0, 600) };
}

const REINSTALL_PLUGIN_ACTION =
    "Turn on or reinstall the Chrome plugin in Codex Desktop.";

export interface BrowserCheckOptions {
    codexHome: string;
    platform: PlatformInfo;
    env?: NodeJS.ProcessEnv;
    /** Node that runs the diagnostics scripts; defaults to the current process. */
    nodePath?: string;
}

/**
 * Chrome backend prerequisites as `PrerequisiteCheck`s. Simulated platforms get `unverified`; when
 * Codex Desktop's Chrome plugin is not installed the caller falls back to file checks.
 */
export async function browserPrerequisiteChecks(
    options: BrowserCheckOptions,
): Promise<{
    checks: PrerequisiteCheck[];
    diagnostics: ChromeDiagnostics | undefined;
}> {
    const env = options.env ?? process.env;
    const ids = {
        installed: "browser-installed",
        running: "browser-running",
        extension: "chrome-extension",
        nativeHost: "chrome-native-host",
    };
    const labels = {
        installed: "Browser Use: Google Chrome",
        running: "Browser Use: Chrome running",
        extension: "Browser Use: ChatGPT extension",
        nativeHost: "Browser Use: native messaging host",
    };
    if (options.platform.isSimulated || !options.platform.supported) {
        const detail = options.platform.supported
            ? "Not checked for a simulated platform."
            : "Unsupported platform.";
        const status = options.platform.supported ? "unverified" : "skipped";
        return {
            diagnostics: undefined,
            checks: (Object.keys(ids) as (keyof typeof ids)[]).map((key) => ({
                id: ids[key],
                label: labels[key],
                status,
                detail,
            })),
        };
    }
    const diagnostics = await locateChromeDiagnostics(options.codexHome);
    if (!diagnostics) return { checks: [], diagnostics: undefined };
    const checks: PrerequisiteCheck[] = [];
    const chrome = await findChromeInstall(options.platform, env);
    checks.push(
        chrome
            ? {
                  id: ids.installed,
                  label: labels.installed,
                  status: "ok",
                  detail: `${chrome.path}${chrome.version ? ` ${chrome.version}` : ""}`,
              }
            : {
                  id: ids.installed,
                  label: labels.installed,
                  status: "missing",
                  detail: "Not found.",
                  action: "Install Google Chrome. Browser Use in pi supports Chrome only.",
              },
    );
    const running = await runDiagnostic(
        diagnostics,
        "chrome-is-running.js",
        ["--browser", BROWSER_FAMILY, "--json"],
        env,
        options.nodePath,
    );
    checks.push(
        running.json?.running === true
            ? {
                  id: ids.running,
                  label: labels.running,
                  status: "ok",
                  detail: "Yes",
              }
            : running.exitCode === 1 || running.json?.running === false
              ? {
                    id: ids.running,
                    label: labels.running,
                    status: "missing",
                    detail: "No",
                    action: "Start Chrome before using Browser Use.",
                }
              : {
                    id: ids.running,
                    label: labels.running,
                    status: "unverified",
                    detail: `chrome-is-running.js failed: ${running.output}`,
                },
    );
    const extension = await runDiagnostic(
        diagnostics,
        "check-extension-installed.js",
        ["--browser", BROWSER_FAMILY, "--json"],
        env,
        options.nodePath,
    );
    const storeHint = diagnostics.storeUrl
        ? ` from ${diagnostics.storeUrl}`
        : "";
    switch (extension.exitCode) {
        case 0:
            checks.push({
                id: ids.extension,
                label: labels.extension,
                status: "ok",
                detail: `Enabled in profile ${extension.json?.selectedProfileDirectory ?? "?"} (${extension.json?.extensionId ?? "?"})`,
            });
            break;
        case 1:
            checks.push({
                id: ids.extension,
                label: labels.extension,
                status: "missing",
                detail: "Installed but disabled.",
                action: "Enable it in chrome://extensions.",
            });
            break;
        case 2:
            checks.push({
                id: ids.extension,
                label: labels.extension,
                status: "missing",
                detail: "Not installed in the selected Chrome profile.",
                action: `Install the ChatGPT extension${storeHint}.`,
            });
            break;
        default:
            checks.push({
                id: ids.extension,
                label: labels.extension,
                status: "unverified",
                detail: `check-extension-installed.js failed: ${extension.output}`,
            });
    }
    const nativeHost = await runDiagnostic(
        diagnostics,
        "check-native-host-manifest.js",
        ["--browser", BROWSER_FAMILY, "--json"],
        env,
        options.nodePath,
    );
    switch (nativeHost.exitCode) {
        case 0:
            checks.push({
                id: ids.nativeHost,
                label: labels.nativeHost,
                status: "ok",
                detail: String(nativeHost.json?.manifestPath ?? "manifest"),
            });
            break;
        case 1:
            checks.push({
                id: ids.nativeHost,
                label: labels.nativeHost,
                status: "missing",
                detail:
                    typeof nativeHost.json?.problem === "string"
                        ? nativeHost.json.problem
                        : `${nativeHost.json?.manifestPath ?? "Manifest"} is missing or incorrect.`,
                action: REINSTALL_PLUGIN_ACTION,
            });
            break;
        default:
            checks.push({
                id: ids.nativeHost,
                label: labels.nativeHost,
                status: "unverified",
                detail: `check-native-host-manifest.js failed: ${nativeHost.output}`,
            });
    }
    return { checks, diagnostics };
}
