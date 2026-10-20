import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
    APP_PATH_OVERRIDE_VARIABLE,
    detectPlatform,
    type PlatformInfo,
    resolveCodexHome,
    type SupportedPlatform,
} from "./platform.js";

const execFileAsync = promisify(execFile);

/** Codex's MCP server name for the unified Computer Use / Browser Use runtime. */
export const CUA_REPL_SERVER_NAME = "cua_repl";
/** Set by the bridge from the feature flags (`browser`, `computer`, or both). */
export const SURFACES_VARIABLE = "CUA_REPL_ENABLED_SURFACES";
/** Filtered by the bridge to the enabled services (`browser`, `sky`). */
export const TRUSTED_SERVICES_VARIABLE = "NODE_REPL_TRUSTED_SERVICES";
/** Where sky looks for the native service first (then `$CODEX_HOME/computer-use`, then the bundle id). */
export const SERVICE_APP_PATH_VARIABLE = "SKY_CUA_SERVICE_PATH";
export const CODEX_DESKTOP_BUNDLE_ID = "com.openai.codex";
export const SERVICE_APP_NAME = "Codex Computer Use.app";
export const UNIFIED_PLUGIN_ID = "unified-computer-use";
export const BROWSER_BACKENDS_VARIABLE = "BROWSER_USE_AVAILABLE_BACKENDS";

/**
 * Chrome is the only backend verified from pi. The Desktop-only iab/mcpapps backends reject pi
 * sessions even while Codex Desktop is running. Keep the runtime's default instruction variant.
 */
export function applyBrowserEnvironment(
    env: Record<string, string>,
    isBrowserEnabled: boolean,
): Record<string, string> {
    return isBrowserEnabled
        ? { ...env, [BROWSER_BACKENDS_VARIABLE]: "chrome" }
        : env;
}

const RUNTIME_RELATIVE_PATH = ["Contents", "Resources", "cua_node"];
const DEFAULT_ENABLED_TOOLS = ["js", "js_reset", "turn_ended"];
const DEFAULT_OUTPUT_TOKEN_LIMIT = 25_000;
const DEFAULT_STARTUP_TIMEOUT_SEC = 120;
const DEFAULT_APP_CANDIDATES = [
    "/Applications/ChatGPT.app",
    join(homedir(), "Applications", "ChatGPT.app"),
    "/Applications/Codex.app",
    join(homedir(), "Applications", "Codex.app"),
];

/** Everything needed to start `cua_repl` the way Codex Desktop does, before feature flags are applied. */
export interface RuntimePlan {
    kind: "plan";
    platform: SupportedPlatform;
    /** `plugin-cache`: Codex Desktop's own `.mcp.json`; `app-bundle`: composed from the app's `cua_node` (macOS only). */
    source: "plugin-cache" | "app-bundle";
    command: string;
    args: string[];
    /**
     * Base environment. From the plugin cache it is verbatim, including `CUA_REPL_ENABLED_SURFACES`
     * and `NODE_REPL_TRUSTED_SERVICES`, which the bridge overrides from the feature flags.
     */
    env: Record<string, string>;
    enabledTools: string[];
    outputTokenLimit: number;
    startupTimeoutSec: number;
    codexHome: string;
    /** The `.mcp.json` the plan came from (plugin cache only). */
    configPath?: string;
    /** Codex Desktop app bundle (macOS) when it could be derived. */
    appPath?: string;
    appVersion?: string;
    /** `cua_node` directory; absent for simulated platforms. */
    runtimeRoot?: string;
    /** `cua_node/lib/node_modules`; absent for simulated platforms. */
    nodeModules?: string;
    isSimulated: boolean;
}

export type RuntimeUnavailableReason =
    | "platform-unsupported"
    | "plugin-cache-missing"
    | "app-not-found"
    | "runtime-invalid";

export interface RuntimeUnavailable {
    kind: "unavailable";
    platform: string;
    reason: RuntimeUnavailableReason;
    /** User-facing explanation naming the missing piece and the next action. */
    message: string;
    codexHome?: string;
}

export type RuntimeDiscovery = RuntimePlan | RuntimeUnavailable;

export interface DiscoveryOptions {
    env?: NodeJS.ProcessEnv;
    platform?: PlatformInfo;
}

export function pluginCacheDir(codexHome: string): string {
    return join(
        codexHome,
        "plugins",
        "cache",
        "openai-bundled",
        UNIFIED_PLUGIN_ID,
    );
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

/** Newest first; numeric segments compare numerically (`26.930.31730`). */
export function compareVersionsDesc(a: string, b: string): number {
    const partsA = a.split(".");
    const partsB = b.split(".");
    const length = Math.max(partsA.length, partsB.length);
    for (let index = 0; index < length; index += 1) {
        const segmentA = partsA[index] ?? "0";
        const segmentB = partsB[index] ?? "0";
        const numberA = Number(segmentA);
        const numberB = Number(segmentB);
        if (Number.isNaN(numberA) || Number.isNaN(numberB)) {
            const order = segmentA.localeCompare(segmentB);
            if (order !== 0) return -order;
            continue;
        }
        if (numberA !== numberB) return numberB - numberA;
    }
    return 0;
}

interface ServerConfig {
    command: string;
    args: string[];
    enabled: boolean;
    env: Record<string, string>;
    enabledTools: string[];
    outputTokenLimit: number;
    startupTimeoutSec: number;
}

async function readServerConfig(
    configPath: string,
): Promise<ServerConfig | undefined> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(configPath, "utf8"));
    } catch {
        return undefined;
    }
    const servers = asRecord(asRecord(parsed)?.mcpServers);
    const server = asRecord(servers?.[CUA_REPL_SERVER_NAME]);
    if (!server || !isString(server.command)) return undefined;
    const args = Array.isArray(server.args) ? server.args.filter(isString) : [];
    const env = Object.fromEntries(
        Object.entries(asRecord(server.env) ?? {}).filter(
            (entry): entry is [string, string] => isString(entry[1]),
        ),
    );
    const enabledTools = Array.isArray(server.enabled_tools)
        ? server.enabled_tools.filter(isString)
        : [...DEFAULT_ENABLED_TOOLS];
    const js = asRecord(asRecord(server.tools)?.js);
    const outputTokenLimit =
        typeof js?.output_token_limit === "number"
            ? js.output_token_limit
            : DEFAULT_OUTPUT_TOKEN_LIMIT;
    const startupTimeoutSec =
        typeof server.startup_timeout_sec === "number"
            ? server.startup_timeout_sec
            : DEFAULT_STARTUP_TIMEOUT_SEC;
    return {
        command: server.command,
        args,
        enabled: server.enabled === true,
        env,
        enabledTools,
        outputTokenLimit,
        startupTimeoutSec,
    };
}

function appPathFromRuntimeRoot(runtimeRoot: string): string | undefined {
    const expectedSuffix = join(...RUNTIME_RELATIVE_PATH);
    return runtimeRoot.endsWith(expectedSuffix)
        ? resolve(runtimeRoot, "..", "..", "..")
        : undefined;
}

function nodeModulesFromEnv(
    env: Record<string, string>,
    runtimeRoot: string | undefined,
): string | undefined {
    const configured = env.NODE_REPL_NODE_MODULE_DIRS?.split(delimiter)[0];
    if (configured) return configured;
    return runtimeRoot ? join(runtimeRoot, "lib", "node_modules") : undefined;
}

async function planFromPluginCache(
    codexHome: string,
    platform: PlatformInfo & { supported: true },
): Promise<RuntimePlan | undefined> {
    const cacheDir = pluginCacheDir(codexHome);
    let versions: string[];
    try {
        versions = (await readdir(cacheDir, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch {
        return undefined;
    }
    for (const version of versions.sort(compareVersionsDesc)) {
        const configPath = join(cacheDir, version, ".mcp.json");
        const server = await readServerConfig(configPath);
        if (!server?.enabled) continue;
        if (!platform.isSimulated && !(await isFile(server.command))) continue;
        const runtimeRoot = platform.isSimulated
            ? undefined
            : dirname(dirname(server.command));
        return {
            kind: "plan",
            platform: platform.platform,
            source: "plugin-cache",
            command: server.command,
            args: server.args,
            env: server.env,
            enabledTools: server.enabledTools,
            outputTokenLimit: server.outputTokenLimit,
            startupTimeoutSec: server.startupTimeoutSec,
            codexHome,
            configPath,
            appPath:
                runtimeRoot && platform.platform === "darwin"
                    ? appPathFromRuntimeRoot(runtimeRoot)
                    : undefined,
            appVersion: server.env.BROWSER_USE_CODEX_APP_VERSION ?? version,
            runtimeRoot,
            nodeModules: platform.isSimulated
                ? undefined
                : nodeModulesFromEnv(server.env, runtimeRoot),
            isSimulated: platform.isSimulated,
        };
    }
    return undefined;
}

interface BundleInfo {
    bundleId?: string;
    version?: string;
}

/** Reads `Info.plist` through `plutil`; returns an empty object when unavailable. */
export async function readBundleInfo(appPath: string): Promise<BundleInfo> {
    try {
        const { stdout } = await execFileAsync(
            "plutil",
            [
                "-convert",
                "json",
                "-o",
                "-",
                join(appPath, "Contents", "Info.plist"),
            ],
            { timeout: 5_000, maxBuffer: 1024 * 1024 },
        );
        const info = asRecord(JSON.parse(stdout)) ?? {};
        return {
            bundleId: isString(info.CFBundleIdentifier)
                ? info.CFBundleIdentifier
                : undefined,
            version: isString(info.CFBundleShortVersionString)
                ? info.CFBundleShortVersionString
                : undefined,
        };
    } catch {
        return {};
    }
}

/** The parts of `cua_node/manifest.json` the package uses (paths are relative to the runtime root). */
export interface RuntimeManifest {
    nodePath: string;
    nodeReplPath: string;
    nodeModules: string;
    nodeVersion?: string;
    /** Plain Node version the bundled `node` binary must report (`setup.sh` compares against it). */
    nodeBinaryVersion?: string;
}

export async function readRuntimeManifest(
    manifestPath: string,
): Promise<RuntimeManifest | undefined> {
    try {
        const manifest = asRecord(
            JSON.parse(await readFile(manifestPath, "utf8")),
        );
        if (
            !manifest ||
            !isString(manifest.node_path) ||
            !isString(manifest.node_repl_path) ||
            !isString(manifest.node_modules)
        )
            return undefined;
        return {
            nodePath: manifest.node_path,
            nodeReplPath: manifest.node_repl_path,
            nodeModules: manifest.node_modules,
            nodeVersion: isString(manifest.node_version)
                ? manifest.node_version
                : undefined,
            nodeBinaryVersion: isString(manifest.node_binary_version)
                ? manifest.node_binary_version
                : undefined,
        };
    } catch {
        return undefined;
    }
}

export type ServiceAppSource = "env" | "codex-home" | "app-bundle";

export interface ServiceAppLocation {
    path: string;
    source: ServiceAppSource;
}

/**
 * Finds `Codex Computer Use.app` in the order sky uses: `SKY_CUA_SERVICE_PATH`, then
 * `$CODEX_HOME/computer-use`, then the copy inside `@oai/sky` (passed explicitly instead of
 * relying on the bundle-id lookup). Never copies anything.
 */
export async function locateServiceApp(options: {
    codexHome: string;
    nodeModules?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<ServiceAppLocation | undefined> {
    const env = options.env ?? process.env;
    const fromEnv = env[SERVICE_APP_PATH_VARIABLE]?.trim();
    if (fromEnv && (await isDirectory(fromEnv)))
        return { path: fromEnv, source: "env" };
    const fromCodexHome = join(
        options.codexHome,
        "computer-use",
        SERVICE_APP_NAME,
    );
    if (await isDirectory(fromCodexHome))
        return { path: fromCodexHome, source: "codex-home" };
    if (options.nodeModules) {
        const fromBundle = join(
            options.nodeModules,
            "@oai",
            "sky",
            SERVICE_APP_NAME,
        );
        if (await isDirectory(fromBundle))
            return { path: fromBundle, source: "app-bundle" };
    }
    return undefined;
}

async function composePlanFromApp(
    appPath: string,
    runtimeRoot: string,
    codexHome: string,
    bundle: BundleInfo,
    platform: PlatformInfo & { supported: true },
    env: NodeJS.ProcessEnv,
): Promise<RuntimeDiscovery> {
    const manifestPath = join(runtimeRoot, "manifest.json");
    const manifest = await readRuntimeManifest(manifestPath);
    if (!manifest)
        return {
            kind: "unavailable",
            platform: platform.platform,
            reason: "runtime-invalid",
            codexHome,
            message: `${manifestPath} does not describe node_path, node_repl_path and node_modules. Update or reinstall Codex Desktop.`,
        };
    const nodePath = join(runtimeRoot, manifest.nodePath);
    const nodeReplPath = join(runtimeRoot, manifest.nodeReplPath);
    const nodeModules = join(runtimeRoot, manifest.nodeModules);
    const launcher = join(
        nodeModules,
        "@oai",
        "cua-repl",
        "bin",
        "cua-repl.mjs",
    );
    const missing: string[] = [];
    for (const file of [nodePath, nodeReplPath, launcher])
        if (!(await isFile(file))) missing.push(file);
    if (!(await isDirectory(nodeModules))) missing.push(nodeModules);
    if (missing.length > 0)
        return {
            kind: "unavailable",
            platform: platform.platform,
            reason: "runtime-invalid",
            codexHome,
            message: `The runtime at ${runtimeRoot} is incomplete (missing ${missing.join(", ")}). Update or reinstall Codex Desktop.`,
        };
    // Same variables Codex Desktop writes into .mcp.json, minus the two the bridge derives from the flags.
    const planEnv: Record<string, string> = {
        NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
        NODE_REPL_NODE_MODULE_DIRS: nodeModules,
        NODE_REPL_NODE_PATH: nodePath,
        NODE_REPL_TRUSTED_CODE_PATHS: [codexHome, nodeModules].join(delimiter),
        CODEX_HOME: codexHome,
        BROWSER_USE_AVAILABLE_BACKENDS: "chrome,iab,mcpapps",
        BROWSER_USE_TINYSKY_ENABLED: "1",
        NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER:
            "Control the in-app browser in conjunction with the Browser Plugin.",
        NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME:
            "Control the Chrome browser in conjunction with the Chrome Plugin. Prefer this method of controlling Chrome over alternatives (such as Computer Use) unless the user explicitly mentions an alternative.",
        NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE: `Control desktop apps on ${platform.label} through Computer Use.`,
        BROWSER_USE_CODEX_APP_BUILD_FLAVOR: "prod",
        CUA_REPL_NODE_REPL_PATH: nodeReplPath,
    };
    if (bundle.version) planEnv.BROWSER_USE_CODEX_APP_VERSION = bundle.version;
    const serviceApp = await locateServiceApp({ codexHome, nodeModules, env });
    if (serviceApp) planEnv[SERVICE_APP_PATH_VARIABLE] = serviceApp.path;
    const codexCli = join(
        appPath,
        "Contents",
        "Resources",
        "codex-cli",
        "CodexCLI.app",
        "Contents",
        "MacOS",
        "codex",
    );
    if (await isFile(codexCli)) planEnv.CODEX_CLI_PATH = codexCli;
    return {
        kind: "plan",
        platform: platform.platform,
        source: "app-bundle",
        command: nodePath,
        args: [launcher],
        env: planEnv,
        enabledTools: [...DEFAULT_ENABLED_TOOLS],
        outputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
        startupTimeoutSec: DEFAULT_STARTUP_TIMEOUT_SEC,
        codexHome,
        appPath,
        appVersion: bundle.version,
        runtimeRoot,
        nodeModules,
        isSimulated: platform.isSimulated,
    };
}

async function planFromAppBundle(
    codexHome: string,
    platform: PlatformInfo & { supported: true },
    env: NodeJS.ProcessEnv,
): Promise<RuntimeDiscovery> {
    const override = env[APP_PATH_OVERRIDE_VARIABLE]?.trim();
    const candidates = override ? [override] : DEFAULT_APP_CANDIDATES;
    for (const appPath of candidates) {
        const runtimeRoot = join(appPath, ...RUNTIME_RELATIVE_PATH);
        if (!(await isFile(join(runtimeRoot, "manifest.json")))) continue;
        const bundle = await readBundleInfo(appPath);
        if (bundle.bundleId && bundle.bundleId !== CODEX_DESKTOP_BUNDLE_ID)
            continue;
        return composePlanFromApp(
            appPath,
            runtimeRoot,
            codexHome,
            bundle,
            platform,
            env,
        );
    }
    return {
        kind: "unavailable",
        platform: platform.platform,
        reason: "app-not-found",
        codexHome,
        message: `Codex Desktop (${CODEX_DESKTOP_BUNDLE_ID}) not found at ${candidates.join(", ")}. Install it, or set ${APP_PATH_OVERRIDE_VARIABLE} to its path.`,
    };
}

/**
 * Locates the Codex Computer Use runtime without writing anywhere. Prefers the newest enabled
 * `.mcp.json` Codex Desktop wrote under `CODEX_HOME`; on macOS falls back to the app bundle.
 */
export async function discoverRuntime(
    options: DiscoveryOptions = {},
): Promise<RuntimeDiscovery> {
    const env = options.env ?? process.env;
    const platform = options.platform ?? detectPlatform(env);
    if (!platform.supported)
        return {
            kind: "unavailable",
            platform: platform.platform,
            reason: "platform-unsupported",
            message: `${platform.label} is not supported. Computer Use requires macOS or Windows.`,
        };
    const codexHome = resolveCodexHome(platform, env);
    const cached = await planFromPluginCache(codexHome, platform);
    if (cached) return cached;
    if (platform.platform === "darwin")
        return planFromAppBundle(codexHome, platform, env);
    return {
        kind: "unavailable",
        platform: platform.platform,
        reason: "plugin-cache-missing",
        codexHome,
        message: `No enabled ${CUA_REPL_SERVER_NAME} config under ${pluginCacheDir(codexHome)}. Turn on Computer Use once in Codex Desktop.`,
    };
}

export function describeRuntime(discovery: RuntimeDiscovery): string {
    if (discovery.kind === "unavailable")
        return `unavailable (${discovery.reason}): ${discovery.message}`;
    const origin =
        discovery.source === "plugin-cache"
            ? `Codex Desktop configuration ${discovery.configPath}`
            : `composed from ${discovery.appPath}`;
    const version = discovery.appVersion
        ? ` (app ${discovery.appVersion})`
        : "";
    const simulated = discovery.isSimulated ? " [simulated]" : "";
    return `${origin}${version}${simulated}`;
}
