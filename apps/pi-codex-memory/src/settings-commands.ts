import type {
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    type CommandOptions,
    duration,
    modelText,
    resultText,
} from "./commands.js";
import { DEFAULT_SETTINGS, isMemoryEnabled } from "./config.js";
import { memoryFailureCode } from "./failure.js";
import { openSettings, type SettingRow } from "./menus.js";
import {
    editRepository,
    repositoryOptions,
    repositorySummary,
} from "./repository-commands.js";
import type { MemoryRuntime } from "./runtime.js";
import { safeError } from "./safety.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type NumberKey =
    | "minIdleMs"
    | "consolidationCooldownMs"
    | "maxRolloutAgeDays"
    | "maxUnusedDays";
/** Settings that Enter and Space cycle through preset values, as Pi's /settings does. */
const NUMBER_ROWS: readonly {
    readonly key: NumberKey;
    readonly label: string;
    readonly description: string;
    readonly format: (value: number) => string;
    readonly presets: readonly number[];
}[] = [
    {
        key: "minIdleMs",
        label: "Create memories after",
        description:
            "How long after its last message a closed conversation becomes memory. Open conversations wait until they close. Shorter makes memories appear sooner but calls the model more often.",
        format: (value) => `${duration(value)} idle`,
        presets: [15 * MINUTE, 30 * MINUTE, 60 * MINUTE, 2 * HOUR, 6 * HOUR],
    },
    {
        key: "consolidationCooldownMs",
        label: "Update the summary every",
        description:
            "How often new memories are merged into the summary sent with each request. New memories can be searched right away; a longer interval uses fewer model calls.",
        format: duration,
        presets: [
            15 * MINUTE,
            30 * MINUTE,
            60 * MINUTE,
            2 * HOUR,
            3 * HOUR,
            6 * HOUR,
        ],
    },
    {
        key: "maxRolloutAgeDays",
        label: "Use conversations from the last",
        description:
            "Only conversations with a message in this period become memory. Older conversations are skipped.",
        format: (value) => `${value} days`,
        presets: [1, 3, 7, 14, 30],
    },
    {
        key: "maxUnusedDays",
        label: "Delete unused memories after",
        description:
            "Memories the agent has not used for this long are deleted. Memories you asked the agent to save or edited yourself are kept.",
        format: (value) => `${value} days`,
        presets: [7, 30, 90, 365],
    },
];

function numberRow(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
    row: (typeof NUMBER_ROWS)[number],
): SettingRow {
    const current = runtime.settings()[row.key];
    const values = [...new Set([...row.presets, current])].sort(
        (a, b) => a - b,
    );
    return {
        id: row.key,
        label: row.label,
        value: row.format(current),
        values: values.map(row.format),
        description: `${row.description} Default: ${row.format(DEFAULT_SETTINGS[row.key])}.`,
        apply: async (label) => {
            const settings = runtime.settings();
            const value = values.find((item) => row.format(item) === label);
            if (value === undefined || value === settings[row.key]) return;
            try {
                await runtime.saveSettings({ ...settings, [row.key]: value });
            } catch (error) {
                ctx.ui.notify(safeError(error), "error");
            }
        },
    };
}
/**
 * Turns the current conversation into memory; in the TUI it keeps running after the page closes.
 * Returns false when the user declines.
 */
async function rememberNow(
    runtime: MemoryRuntime,
    ctx: ExtensionCommandContext,
): Promise<boolean> {
    if (
        !(await ctx.ui.confirm(
            "Remember this conversation now?",
            `Pi masks a copy of this conversation and sends it to ${modelText(runtime.settings(), ctx)}. This uses your provider quota or costs money.`,
        ))
    )
        return false;
    const work = runtime.run("current");
    if (ctx.mode !== "tui") {
        const result = await work;
        ctx.ui.notify(resultText(result), result.failed ? "error" : "info");
        return true;
    }
    // The TUI waits for command handlers before taking input; let the job finish on its own.
    ctx.ui.notify(
        "Remembering this conversation. To stop, open /codex-memory-settings.",
        "info",
    );
    void work.then(
        (result) => {
            if (runtime.isActive())
                ctx.ui.notify(
                    resultText(result),
                    result.failed ? "error" : "info",
                );
        },
        (error) => {
            if (runtime.isActive() && memoryFailureCode(error) !== "aborted")
                ctx.ui.notify(safeError(error), "error");
        },
    );
    return true;
}
async function forgetAll(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
): Promise<void> {
    if (
        !(await ctx.ui.confirm(
            "Forget all memories in this scope?",
            `Clears every memory and summary for ${runtime.scopeName()}. The conversations they came from will not create them again. Your Pi sessions are not changed.`,
        ))
    )
        return;
    await runtime.cancel();
    runtime.store.reset(runtime.scope);
    ctx.ui.notify("All memories in this scope were forgotten.", "info");
}
function settingRows(
    runtime: MemoryRuntime,
    options: CommandOptions,
): SettingRow[] {
    const { ctx, repositories } = options;
    const settings = runtime.settings();
    return [
        ...(runtime.isRunning
            ? [
                  {
                      id: "stop",
                      label: "Stop current job",
                      value: "running",
                      description: "Stops the memory job that is running now.",
                  },
              ]
            : isMemoryEnabled(settings)
              ? [
                    {
                        id: "remember",
                        label: "Remember this conversation now",
                        value: "",
                        description: `Turns this conversation into memory now instead of after it closes. Calls ${modelText(settings, ctx)}.`,
                    },
                ]
              : []),
        ...(runtime.failure
            ? [
                  {
                      id: "failure",
                      label: "Show what failed",
                      value: "",
                      description:
                          "Shows the last error and recent memory jobs.",
                  },
              ]
            : []),
        ...NUMBER_ROWS.map((row) => numberRow(runtime, ctx, row)),
        {
            id: "repositories",
            label: "Other repositories",
            value: repositorySummary(repositories),
            description:
                "Repositories whose memories the agent may read from here, and whether it asks first. Access goes one way; their memories are never copied or changed.",
            options: () => repositoryOptions(repositories),
        },
        {
            id: "reset",
            label: "Forget all memories in this scope",
            value: "",
            description: `Deletes every memory and summary for ${runtime.scopeName()}. The conversations they came from will not create them again.`,
        },
    ];
}

/** `/codex-memory-settings`: memory jobs, timing, limits and other repositories. */
export async function settingsCommand(options: CommandOptions): Promise<void> {
    const { ctx, runtime, show } = options;
    if (!ctx.hasUI) {
        show(JSON.stringify(runtime.status(), null, 2));
        return;
    }
    let selectedId: string | undefined;
    while (true) {
        const choice = await openSettings(
            ctx,
            "Codex Memory settings",
            () => settingRows(runtime, options),
            { selectedId, isSearchable: true },
        );
        if (!choice || !runtime.hasCurrentScope()) return;
        selectedId = choice.id;
        try {
            if (choice.id === "remember") {
                if (await rememberNow(runtime, ctx)) return;
            } else if (choice.id === "stop") {
                await runtime.cancel();
                ctx.ui.notify("Stopped the memory job.", "info");
            } else if (choice.id === "failure") {
                show(JSON.stringify(runtime.status(), null, 2));
                return;
            } else if (choice.id === "repositories" && choice.value)
                await editRepository(options.repositories, ctx, choice.value);
            else if (choice.id === "reset") await forgetAll(runtime, ctx);
        } catch (error) {
            if (!runtime.isActive() || memoryFailureCode(error) === "aborted")
                return;
            ctx.ui.notify(safeError(error), "error");
            if (!runtime.hasCurrentScope()) return;
        }
    }
}
