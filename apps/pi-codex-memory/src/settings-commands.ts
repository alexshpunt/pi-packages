import type {
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    type MemorySettings,
    type ModelChoice,
    parseSettings,
    settingRange,
} from "./config.js";
import { MemoryUserError } from "./failure.js";
import {
    editRepositoryAccess,
    type RepositoryCommandContext,
} from "./repository-commands.js";
import type { MemoryRuntime } from "./runtime.js";
import { safeError } from "./safety.js";

/** Settings shown as plain numbers; `scale` converts the shown unit to the stored value. */
const NUMBER_ROWS = [
    {
        key: "minIdleMs",
        label: "Idle time before creating memories",
        unit: "minutes",
        scale: 60_000,
    },
    {
        key: "consolidationCooldownMs",
        label: "Consolidation interval",
        unit: "minutes",
        scale: 60_000,
    },
    {
        key: "maxUnusedDays",
        label: "Keep unused memories",
        unit: "days",
        scale: 1,
    },
    {
        key: "maxCallsPerDay",
        label: "Model calls per UTC day",
        unit: "calls",
        scale: 1,
    },
] as const satisfies readonly {
    key: keyof MemorySettings;
    label: string;
    unit: string;
    scale: number;
}[];

function modelName(model: ModelChoice): string {
    const name = `${model.provider}/${model.id}`;
    return model.reasoning ? `${name} · ${model.reasoning} reasoning` : name;
}
function isSameModel(left: ModelChoice | null, right: ModelChoice | null) {
    return JSON.stringify(left) === JSON.stringify(right);
}
export function modelText(settings: MemorySettings): string {
    const { extractModel, consolidateModel } = settings;
    if (!extractModel || !consolidateModel) return "not set";
    return isSameModel(extractModel, consolidateModel)
        ? modelName(extractModel)
        : `${modelName(extractModel)} (extraction), ${modelName(consolidateModel)} (consolidation)`;
}
/** One model for both stages, with each stage's default reasoning. */
async function pickModel(
    ctx: ExtensionContext,
): Promise<ModelChoice | undefined> {
    const names = ctx.modelRegistry
        .getAvailable()
        .map((model) => `${model.provider}/${model.id}`)
        .sort();
    if (!names.length)
        throw new MemoryUserError(
            "No models are available. Set up a provider in Pi first.",
        );
    const choice = await ctx.ui.select("Choose a model for memories", names);
    if (!choice) return undefined;
    const slash = choice.indexOf("/");
    return { provider: choice.slice(0, slash), id: choice.slice(slash + 1) };
}
/** Consent for sending conversation copies; required whenever creation turns on or its models change. */
async function confirmCreation(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
    settings: MemorySettings,
): Promise<boolean> {
    return ctx.ui.confirm(
        "Send conversations to create memories?",
        [
            `Pi masks copies of conversations in ${runtime.scopeName()} and sends them to ${modelText(settings)}.`,
            "This uses your provider quota or costs money. Masking can miss private values.",
            `At most ${settings.maxCallsPerDay} model calls a day, up to ${Math.round(settings.maxInputBytes / 1024)} KiB each. Your Pi sessions are not changed.`,
        ].join("\n"),
    );
}
function needsConsent(before: MemorySettings, after: MemorySettings): boolean {
    return (
        after.generateMemories &&
        (!before.generateMemories ||
            !isSameModel(before.extractModel, after.extractModel) ||
            !isSameModel(before.consolidateModel, after.consolidateModel))
    );
}
/** Turns on "use and create": picks a model if none is set, then asks for consent. */
export async function enableCreation(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
): Promise<boolean> {
    const before = runtime.settings();
    let models = {};
    if (!before.extractModel || !before.consolidateModel) {
        const model = await pickModel(ctx);
        if (!model) return false;
        models = { extractModel: model, consolidateModel: model };
    }
    const after = parseSettings({
        ...before,
        ...models,
        useMemories: true,
        generateMemories: true,
    });
    if (
        needsConsent(before, after) &&
        !(await confirmCreation(runtime, ctx, after))
    )
        return false;
    await runtime.saveSettings(after);
    ctx.ui.notify(
        `Memory creation is on. A conversation becomes memory after ${after.minIdleMs / 60_000} idle minutes.`,
        "info",
    );
    return true;
}
async function save(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
    value: unknown,
): Promise<boolean> {
    const before = runtime.settings();
    let after: MemorySettings;
    try {
        after = parseSettings(value);
    } catch (error) {
        throw new MemoryUserError(
            error instanceof Error ? error.message : "Invalid settings.",
        );
    }
    if (
        needsConsent(before, after) &&
        !(await confirmCreation(runtime, ctx, after))
    )
        return false;
    await runtime.saveSettings(after);
    return true;
}
async function editNumber(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
    row: (typeof NUMBER_ROWS)[number],
): Promise<void> {
    const settings = runtime.settings();
    const input = await ctx.ui.input(
        `${row.label} (${row.unit})`,
        String(settings[row.key] / row.scale),
    );
    if (input === undefined) return;
    const [min, max] = settingRange(row.key)!;
    const value = Number(input.trim());
    if (
        !/^\d+$/.test(input.trim()) ||
        value * row.scale < min ||
        value * row.scale > max
    )
        throw new MemoryUserError(
            `Enter a whole number from ${Math.ceil(min / row.scale)} to ${Math.floor(max / row.scale)} ${row.unit}.`,
        );
    await save(runtime, ctx, { ...settings, [row.key]: value * row.scale });
}
async function editJson(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
): Promise<void> {
    const text = await ctx.ui.editor(
        `Memory settings for ${runtime.scopeName()} (JSON)`,
        JSON.stringify(runtime.settings(), null, 2),
    );
    if (text === undefined) return;
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new MemoryUserError(
            "The text is not valid JSON; nothing was saved.",
        );
    }
    if (await save(runtime, ctx, value))
        ctx.ui.notify("Memory settings saved.", "info");
}
async function editScope(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
    changeScope: (mode: "workspace" | "global") => Promise<void>,
): Promise<boolean> {
    const current =
        runtime.scope === "global" ? "Personal" : "This repository or folder";
    const choice = await ctx.ui.select("Memory scope", [
        "This repository or folder",
        "Personal",
        "Back",
    ]);
    if (!choice || choice === "Back" || choice === current) return false;
    if (
        !(await ctx.ui.confirm(
            `Switch to ${choice === "Personal" ? "personal" : "repository or folder"} memory?`,
            choice === "Personal"
                ? "This folder uses your personal memory, which every folder set to Personal shares along with its settings. Existing memories are not copied or merged."
                : "This repository, its subfolders and worktrees share one memory and its settings. Outside Git, each folder has its own. Existing memories are not copied or merged.",
        ))
    )
        return false;
    await changeScope(choice === "Personal" ? "global" : "workspace");
    ctx.ui.notify(
        "Memory scope changed. This scope has its own settings.",
        "info",
    );
    return true;
}
export async function settingsCommand(options: {
    ctx: ExtensionCommandContext;
    runtime: MemoryRuntime;
    repositories: RepositoryCommandContext;
    show: (text: string) => void;
    changeScope: (mode: "workspace" | "global") => Promise<void>;
}): Promise<void> {
    const { ctx, runtime, show } = options;
    if (!ctx.hasUI) {
        show(JSON.stringify(runtime.settings(), null, 2));
        return;
    }
    while (true) {
        const settings = runtime.settings();
        const numbers = NUMBER_ROWS.map(
            (row) =>
                `${row.label}: ${settings[row.key] / row.scale} ${row.unit}`,
        );
        const rows = [
            `Model: ${modelText(settings)}`,
            ...numbers,
            `Memory scope: ${runtime.scope === "global" ? "Personal" : "This repository or folder"}`,
            "Repository access",
            "Edit all settings as JSON",
            "Close",
        ];
        const choice = await ctx.ui.select(
            `Memory settings · ${runtime.scopeName()}`,
            rows,
        );
        if (!choice || choice === "Close") return;
        try {
            const number = NUMBER_ROWS[numbers.indexOf(choice)];
            if (number) await editNumber(runtime, ctx, number);
            else if (choice === rows[0]) {
                const model = await pickModel(ctx);
                if (model)
                    await save(runtime, ctx, {
                        ...settings,
                        extractModel: model,
                        consolidateModel: model,
                    });
            } else if (choice.startsWith("Memory scope")) {
                if (await editScope(runtime, ctx, options.changeScope)) return;
            } else if (choice === "Repository access")
                await editRepositoryAccess(options.repositories, ctx);
            else if (choice === "Edit all settings as JSON")
                await editJson(runtime, ctx);
        } catch (error) {
            ctx.ui.notify(safeError(error), "error");
        }
    }
}
