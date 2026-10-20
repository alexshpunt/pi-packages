import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
    checkPrerequisites,
    formatPrerequisiteReport,
    formatSetupGuide,
} from "./install.js";
import { describePlatform, detectPlatform } from "./platform.js";
import { describeRuntime, discoverRuntime } from "./runtime.js";
import {
    describeFeatureState,
    type FeatureKey,
    type FeatureState,
    type SettingsLoadResult,
} from "./settings.js";
import { ComputerUseSettingsPanel } from "./settings-ui.js";

export const COMMAND_NAME = "computer-use";
export const CHECK_COMMAND_NAME = "computer-use-check";
export const COMMAND_USAGE = `/${COMMAND_NAME} [status | check | computer on|off | browser on|off]`;

const FEATURE_LABELS: Record<FeatureKey, string> = {
    computerUse: "Computer Use",
    browserUse: "Browser Use",
};

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type CompletionItem = NonNullable<
    Awaited<ReturnType<NonNullable<CommandOptions["getArgumentCompletions"]>>>
>[number];

const COMPLETIONS: CompletionItem[] = [
    {
        value: "status",
        label: "status",
        description: "Feature state and runtime location",
    },
    {
        value: "check",
        label: "check",
        description: `Same as /${CHECK_COMMAND_NAME}`,
    },
    {
        value: "computer on",
        label: "computer on",
        description: "Enable Computer Use",
    },
    {
        value: "computer off",
        label: "computer off",
        description: "Disable Computer Use",
    },
    {
        value: "browser on",
        label: "browser on",
        description: "Enable Browser Use",
    },
    {
        value: "browser off",
        label: "browser off",
        description: "Disable Browser Use",
    },
];

export interface CommandDependencies {
    settingsPath: string;
    /** Settings as loaded for this session (or defaults before `session_start`). */
    getSettings(): SettingsLoadResult;
    /** Persists a feature state and restarts/re-registers the shared runtime. */
    updateState(
        next: FeatureState,
        ctx: ExtensionCommandContext,
    ): Promise<void>;
    /** Current runtime connection state, including startup failures. */
    describeServer(): string;
}

type NotifyType = Parameters<ExtensionCommandContext["ui"]["notify"]>[1];

/** pi's no-UI modes (print, JSON) implement `notify` as a no-op, so mirror the text to stderr there. */
function report(
    ctx: ExtensionCommandContext,
    text: string,
    type: NotifyType = "info",
): void {
    ctx.ui.notify(text, type);
    if (!ctx.hasUI) process.stderr.write(`${text}\n`);
}

function settingsSourceLabel(settings: SettingsLoadResult): string {
    switch (settings.source) {
        case "defaults":
            return "defaults, no settings file yet";
        case "file":
            return "from settings file";
        case "invalid":
            return "INVALID settings file, both features forced off";
    }
}

async function showStatus(
    ctx: ExtensionCommandContext,
    deps: CommandDependencies,
): Promise<void> {
    const settings = deps.getSettings();
    const runtime = await discoverRuntime();
    const lines = [
        `Codex Computer Use — ${describeFeatureState(settings.state)} (${settingsSourceLabel(settings)})`,
        `Settings: ${deps.settingsPath}`,
        `Platform: ${describePlatform(detectPlatform())}`,
        `Runtime: ${describeRuntime(runtime)}`,
        `Server: ${deps.describeServer()}`,
        `Run /${CHECK_COMMAND_NAME} to check prerequisites.`,
    ];
    if (settings.error) lines.splice(1, 0, `Settings error: ${settings.error}`);
    report(
        ctx,
        lines.join("\n"),
        settings.source === "invalid" ? "warning" : "info",
    );
}

async function runCheck(
    ctx: ExtensionCommandContext,
    deps: CommandDependencies,
): Promise<void> {
    report(ctx, "Checking Computer Use prerequisites…");
    const settings = deps.getSettings();
    const prerequisites = await checkPrerequisites();
    const counts = {
        missing: prerequisites.checks.filter(
            (check) => check.status === "missing",
        ).length,
        unverified: prerequisites.checks.filter(
            (check) => check.status === "unverified",
        ).length,
        userOwned: prerequisites.checks.filter(
            (check) => check.status === "user-owned",
        ).length,
    };
    const missingBrowser = prerequisites.checks.filter(
        (check) =>
            check.status === "missing" &&
            (check.id.startsWith("browser-") || check.id.startsWith("chrome-")),
    );
    const source =
        settings.source === "file" ? "" : ` (${settingsSourceLabel(settings)})`;
    const lines = [
        `Computer Use check — ${describeFeatureState(settings.state)}${source}`,
        `Summary: ${counts.missing} missing · ${counts.unverified} unverified · ${counts.userOwned} to confirm yourself`,
        "",
        ...formatPrerequisiteReport(prerequisites),
        `Server: ${deps.describeServer()}`,
        "",
        ...formatSetupGuide(prerequisites),
    ];
    if (settings.error)
        lines.push(
            "",
            `Settings error: ${settings.error}`,
            `Fix ${deps.settingsPath}, then run /reload.`,
        );
    if (settings.state.browserUse && missingBrowser.length > 0)
        lines.push(
            `Browser Use is on but missing: ${missingBrowser.map((check) => check.label.replace(/^Browser Use: /, "")).join(", ")}.`,
        );
    report(
        ctx,
        lines.join("\n"),
        counts.missing > 0 || settings.error ? "warning" : "info",
    );
}

async function setFeature(
    ctx: ExtensionCommandContext,
    deps: CommandDependencies,
    key: FeatureKey,
    isEnabled: boolean,
): Promise<void> {
    await ctx.waitForIdle();
    const settings = deps.getSettings();
    if (settings.source === "invalid")
        throw new Error(
            `Cannot change settings: ${settings.error}. Fix the file and reload the session.`,
        );
    if (settings.state[key] === isEnabled) return;
    await deps.updateState({ ...settings.state, [key]: isEnabled }, ctx);
}

async function toggleFeature(
    ctx: ExtensionCommandContext,
    deps: CommandDependencies,
    key: FeatureKey,
    isEnabled: boolean,
): Promise<void> {
    try {
        await setFeature(ctx, deps, key, isEnabled);
        report(
            ctx,
            `${FEATURE_LABELS[key]}: ${isEnabled ? "on" : "off"}. ${describeFeatureState(deps.getSettings().state)}.`,
        );
    } catch (error) {
        report(
            ctx,
            error instanceof Error ? error.message : String(error),
            "error",
        );
    }
}

/** RPC has dialog methods but cannot render custom terminal components. Keep its picker open. */
async function rpcSettings(
    ctx: ExtensionCommandContext,
    deps: CommandDependencies,
): Promise<void> {
    for (;;) {
        const settings = deps.getSettings();
        const choices = [
            `Computer Use: ${settings.state.computerUse ? "on" : "off"}`,
            `Browser Use: ${settings.state.browserUse ? "on" : "off"}`,
            "Close",
        ];
        const choice = await ctx.ui.select("Computer Use settings", choices);
        const index = choices.indexOf(choice ?? "");
        if (index === 0 || index === 1) {
            const key = index === 0 ? "computerUse" : "browserUse";
            await toggleFeature(ctx, deps, key, !settings.state[key]);
        } else {
            return;
        }
    }
}

async function openSettings(
    ctx: ExtensionCommandContext,
    deps: CommandDependencies,
): Promise<void> {
    await ctx.waitForIdle();
    if (ctx.mode !== "tui") return rpcSettings(ctx, deps);
    await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) =>
            new ComputerUseSettingsPanel({
                getSettings: () => deps.getSettings(),
                setFeature: (key, isEnabled) =>
                    setFeature(ctx, deps, key, isEnabled),
                theme,
                keybindings,
                requestRender: () => tui.requestRender(),
                onClose: () => done(),
            }),
    );
}

export function registerCodexComputerUseCommand(
    pi: ExtensionAPI,
    deps: CommandDependencies,
): void {
    pi.registerCommand(CHECK_COMMAND_NAME, {
        description: "Check Computer Use and Browser Use prerequisites.",
        handler: async (args, ctx) => {
            if (args.trim()) {
                report(ctx, `Usage: /${CHECK_COMMAND_NAME}`, "error");
                return;
            }
            try {
                await runCheck(ctx, deps);
            } catch (error) {
                report(
                    ctx,
                    `Check failed: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
            }
        },
    });
    pi.registerCommand(COMMAND_NAME, {
        description: "Open Computer Use and Browser Use settings.",
        getArgumentCompletions: (prefix) => {
            const needle = prefix.trim().toLowerCase();
            const matches = COMPLETIONS.filter((item) =>
                item.value.startsWith(needle),
            );
            return matches.length > 0 ? matches : null;
        },
        handler: async (args, ctx) => {
            const words = args.trim().split(/\s+/).filter(Boolean);
            if (words.length === 0)
                return ctx.hasUI
                    ? openSettings(ctx, deps)
                    : showStatus(ctx, deps);
            const [first, second] = words;
            if (words.length === 1 && first === "status")
                return showStatus(ctx, deps);
            if (words.length === 1 && first === "check")
                return runCheck(ctx, deps);
            const key: FeatureKey | undefined =
                first === "computer"
                    ? "computerUse"
                    : first === "browser"
                      ? "browserUse"
                      : undefined;
            if (
                key &&
                words.length === 2 &&
                (second === "on" || second === "off")
            )
                return toggleFeature(ctx, deps, key, second === "on");
            report(ctx, `Usage: ${COMMAND_USAGE}`, "error");
        },
    });
}
