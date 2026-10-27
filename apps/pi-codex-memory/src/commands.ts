import type {
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    isMemoryEnabled,
    type MemorySettings,
    type ModelChoice,
    parseSettings,
} from "./config.js";
import type { MemoryCreationRange } from "./coordinator.js";
import { MemoryUserError, memoryFailureCode } from "./failure.js";
import {
    type Option,
    type OptionListSettings,
    openSettings,
    type SettingRow,
} from "./menus.js";
import type { RepositoryCommandContext } from "./repository-commands.js";
import type { MemoryRuntime } from "./runtime.js";
import { safeError } from "./safety.js";
import { browseMemories, savedMemoriesRow } from "./saved-memories.js";

export interface CommandOptions {
    ctx: ExtensionCommandContext;
    runtime: MemoryRuntime;
    repositories: RepositoryCommandContext;
    show: (text: string) => void;
}

const MINUTE = 60_000;
/** The width Pi gives its model list in /settings. */
const MODEL_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46 };

export function duration(ms: number): string {
    const minutes = ms / MINUTE;
    return minutes >= 120 && minutes % 60 === 0
        ? `${minutes / 60} hours`
        : `${minutes} minutes`;
}
function modelKey(model: Pick<ModelChoice, "provider" | "id">): string {
    return `${model.provider}/${model.id}`;
}
/** Pi's model label: `id [provider]`. */
function modelName(model: ModelChoice): string {
    const name = `${model.id} [${model.provider}]`;
    return model.reasoning ? `${name} · ${model.reasoning} reasoning` : name;
}
function isSameModel(left: ModelChoice | null, right: ModelChoice | null) {
    return JSON.stringify(left) === JSON.stringify(right);
}
/** The option and stored null that follow the model selected for the main task, as in Auto Review. */
const CURRENT_MODEL = "current";
type ModelStage = "extractModel" | "consolidateModel";
const MODEL_ROWS: readonly {
    readonly key: ModelStage;
    readonly label: string;
    readonly description: string;
    readonly listDescription: string;
}[] = [
    {
        key: "extractModel",
        label: "Memory model",
        description:
            "The model that reads closed conversations and writes memories. Lists the models chosen in /scoped-models.",
        listDescription:
            "Reads closed conversations and writes memories, with low reasoning or the nearest level the model offers.",
    },
    {
        key: "consolidateModel",
        label: "Summary model",
        description:
            "The model that merges memories into the summary sent with each request. Lists the models chosen in /scoped-models.",
        listDescription:
            "Merges memories into the summary sent with each request, with medium reasoning or the nearest level the model offers.",
    },
];
function choiceName(choice: ModelChoice | null): string {
    return choice ? modelName(choice) : "Current Pi model";
}
/** Where memory sends conversation copies, for confirmations. */
export function modelText(
    settings: MemorySettings,
    ctx: ExtensionContext,
): string {
    const describe = (choice: ModelChoice | null) => {
        if (choice) return modelName(choice);
        const model = ctx.model;
        return model
            ? `the current Pi model (now ${model.id} [${model.provider}])`
            : "the current Pi model";
    };
    const memory = describe(settings.extractModel),
        summary = describe(settings.consolidateModel);
    return memory === summary
        ? memory
        : `${memory} for memories and ${summary} for the summary`;
}
/** The models chosen in /scoped-models, as Pi's model picker lists them; every available model when none are. */
function memoryModels(ctx: ExtensionContext) {
    const available = ctx.modelRegistry
        .getAvailable()
        .map(({ provider, id }) => ({ provider, id }));
    const scoped = ctx.scopedModels ?? [];
    const models = scoped.length
        ? scoped
              .map(({ model }) => ({ provider: model.provider, id: model.id }))
              .filter((model) =>
                  available.some((item) => modelKey(item) === modelKey(model)),
              )
        : available;
    return models.filter(
        (model, index) =>
            models.findIndex((item) => modelKey(item) === modelKey(model)) ===
            index,
    );
}
/** The option for a stored choice; none when it carries custom reasoning that no option shows. */
function choiceValue(choice: ModelChoice | null): string | undefined {
    if (!choice) return CURRENT_MODEL;
    return choice.reasoning ? undefined : modelKey(choice);
}
function modelOptions(
    ctx: ExtensionContext,
    row: (typeof MODEL_ROWS)[number],
    choice: ModelChoice | null,
): {
    title: string;
    description: string;
    options: Option[];
} & OptionListSettings {
    const current = choiceValue(choice);
    // Pi's order: the current model first, then by provider, keeping each provider's order.
    const models = [...memoryModels(ctx)].sort((a, b) =>
        modelKey(a) === current
            ? -1
            : modelKey(b) === current
              ? 1
              : a.provider.localeCompare(b.provider),
    );
    return {
        title: row.label,
        description: row.listDescription,
        options: [
            {
                value: CURRENT_MODEL,
                label: "Use current Pi model",
                description: "Follow the model selected for the main task.",
            },
            ...models.map((model) => ({
                value: modelKey(model),
                label: model.id,
                hint: `[${model.provider}]`,
            })),
        ],
        preselect: current,
        isSearchable: models.length > 0,
        layout: MODEL_LAYOUT,
    };
}
function parseModel(value: string): ModelChoice | null {
    if (value === CURRENT_MODEL) return null;
    const slash = value.indexOf("/");
    return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
/** Consent for sending conversation copies; required whenever memory turns on or a model changes. */
async function confirmSending(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
    settings: MemorySettings,
): Promise<boolean> {
    return ctx.ui.confirm(
        "Send conversations to create memories?",
        [
            `Pi masks copies of conversations in ${runtime.scopeName()} and sends them to ${modelText(settings, ctx)}.`,
            "This uses your provider quota or costs money. Masking can miss private values.",
            `Each model call sends up to ${Math.round(settings.maxInputBytes / 1024)} KiB. Your Pi sessions are not changed.`,
        ].join("\n"),
    );
}
/** Saves settings, asking for consent first when memory turns on or changes a model. */
async function saveWithConsent(
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
        after.generateMemories &&
        (!before.generateMemories ||
            !isSameModel(before.extractModel, after.extractModel) ||
            !isSameModel(before.consolidateModel, after.consolidateModel)) &&
        !(await confirmSending(runtime, ctx, after))
    )
        return false;
    await runtime.saveSettings(after);
    return true;
}
/** Turns memory on after consent; unset models follow the current Pi model. */
async function turnOn(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
): Promise<void> {
    const after = {
        ...runtime.settings(),
        useMemories: true,
        generateMemories: true,
    };
    if (!(await saveWithConsent(runtime, ctx, after))) return;
    ctx.ui.notify(
        `Memory is on. A closed conversation becomes memory ${duration(after.minIdleMs)} after its last message.`,
        "info",
    );
}
async function setModel(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
    row: (typeof MODEL_ROWS)[number],
    value: string,
): Promise<void> {
    const settings = runtime.settings();
    if (value === choiceValue(settings[row.key])) return;
    const model = parseModel(value);
    if (await saveWithConsent(runtime, ctx, { ...settings, [row.key]: model }))
        ctx.ui.notify(`${row.label}: ${choiceName(model)}.`, "info");
}
function scopeLabel(runtime: MemoryRuntime): string {
    if (runtime.scope === "global") return "Personal";
    return runtime.repository ? "This repository" : "This folder";
}
async function changeScope(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
    value: string,
    select: (mode: "workspace" | "global") => Promise<void>,
): Promise<boolean> {
    if (value === scopeLabel(runtime)) return false;
    const isPersonal = value === "Personal";
    if (
        !(await ctx.ui.confirm(
            isPersonal
                ? "Use personal memory in this folder?"
                : `Use ${runtime.repository ? "repository" : "folder"} memory?`,
            isPersonal
                ? "This folder uses your personal memory, which every folder set to Personal shares along with its settings. Existing memories are not copied or merged."
                : "This repository, its subfolders and worktrees share one memory and its settings. Outside Git, each folder has its own. Existing memories are not copied or merged.",
        ))
    )
        return false;
    await select(isPersonal ? "global" : "workspace");
    ctx.ui.notify(
        "Memory scope changed. This scope has its own settings.",
        "info",
    );
    return true;
}
function memoryRows(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
): SettingRow[] {
    const settings = runtime.settings();
    return [
        {
            id: "enabled",
            label: "Enabled",
            value: isMemoryEnabled(settings) ? "on" : "off",
            values: ["on", "off"],
            description:
                "Turns closed conversations into memories and uses them in later sessions, by sending masked copies to the models below. Off keeps saved memories without using them.",
        },
        ...MODEL_ROWS.map((row) => ({
            id: row.key,
            label: row.label,
            value: choiceName(settings[row.key]),
            description: row.description,
            options: () => modelOptions(ctx, row, runtime.settings()[row.key]),
        })),
        {
            id: "scope",
            label: "Memory scope",
            value: scopeLabel(runtime),
            values: [
                runtime.repository ? "This repository" : "This folder",
                "Personal",
            ],
            description: runtime.repository
                ? "Which folders share these memories and settings: this repository with its subfolders and worktrees, or every folder set to Personal."
                : "Which folders share these memories and settings: only this folder, or every folder set to Personal.",
        },
        savedMemoriesRow(runtime),
        ...(!isMemoryEnabled(settings)
            ? []
            : runtime.isRunning
              ? [
                    {
                        id: "stop",
                        label: "Stop current job",
                        value: "running",
                        description:
                            "Stops the memory jobs this Pi session is running.",
                    },
                ]
              : [
                    {
                        id: "create",
                        label: "Create memories now",
                        value: "",
                        description: `Choose all closed conversations or the configured recent period, without waiting ${duration(settings.minIdleMs)}, then update the summary.`,
                        options: () => {
                            const days = runtime.settings().maxRolloutAgeDays;
                            return {
                                title: "Create memories now",
                                preselect: "recent",
                                options: [
                                    {
                                        value: "recent",
                                        label: `Last ${days} day${days === 1 ? "" : "s"}`,
                                    },
                                    {
                                        value: "all",
                                        label: "All closed conversations",
                                    },
                                ],
                            };
                        },
                    },
                ]),
    ];
}
export function resultText(result: {
    extracted: number;
    failed: number;
}): string {
    if (result.failed)
        return `Memory creation failed for ${result.failed} conversation(s). Open /codex-memory-settings and choose Show what failed.`;
    if (result.extracted)
        return `Created memories from ${result.extracted} conversation(s).`;
    return "No new memories were created.";
}
/** Starts a manual run of closed conversations; in the TUI it keeps running after the page closes. */
async function createNow(
    runtime: MemoryRuntime,
    ctx: ExtensionCommandContext,
    range: MemoryCreationRange,
): Promise<void> {
    let waitMs = 0;
    const work = runtime.createNow((ms) => {
        waitMs = ms;
    }, range);
    if (ctx.mode !== "tui") {
        const result = await work;
        ctx.ui.notify(resultText(result), result.failed ? "error" : "info");
        return;
    }
    ctx.ui.notify(
        waitMs
            ? `Creating memories in about ${Math.ceil(waitMs / 1000)} seconds, once open sessions have checked in.`
            : "Creating memories from closed conversations.",
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
}

/** `/codex-memory`: the switch, the models, the scope, saved memories and a manual run. */
export async function memoryCommand(
    options: CommandOptions & {
        changeScope: (mode: "workspace" | "global") => Promise<void>;
    },
): Promise<void> {
    const { ctx, runtime, show } = options;
    if (!ctx.hasUI) {
        show(JSON.stringify(runtime.status(), null, 2));
        return;
    }
    let selectedId: string | undefined;
    while (true) {
        const choice = await openSettings(
            ctx,
            "Codex Memory",
            () => memoryRows(runtime, ctx),
            { selectedId },
        );
        if (!choice || !runtime.hasCurrentScope()) return;
        selectedId = choice.id;
        try {
            if (choice.id === "memories") {
                if (choice.value)
                    await browseMemories(
                        runtime,
                        ctx,
                        choice.value,
                        choice.query,
                    );
                continue;
            }
            if (choice.id === "create") {
                if (choice.value === "all" || choice.value === "recent") {
                    await createNow(runtime, ctx, choice.value);
                    return;
                }
                continue;
            }
            if (choice.id === "stop") {
                await runtime.cancel();
                ctx.ui.notify("Stopped the memory job.", "info");
                continue;
            }
        } catch (error) {
            if (!runtime.isActive() || memoryFailureCode(error) === "aborted")
                return;
            ctx.ui.notify(safeError(error), "error");
            continue;
        }
        if (!choice.value) continue;
        const modelRow = MODEL_ROWS.find((row) => row.key === choice.id);
        try {
            if (choice.id === "enabled") {
                if (choice.value === "on") {
                    if (!isMemoryEnabled(runtime.settings()))
                        await turnOn(runtime, ctx);
                } else if (isMemoryEnabled(runtime.settings())) {
                    await runtime.saveSettings({
                        ...runtime.settings(),
                        useMemories: false,
                        generateMemories: false,
                    });
                    ctx.ui.notify(
                        "Memory is off. Saved memories are kept.",
                        "info",
                    );
                }
            } else if (modelRow)
                await setModel(runtime, ctx, modelRow, choice.value);
            else if (
                choice.id === "scope" &&
                (await changeScope(
                    runtime,
                    ctx,
                    choice.value,
                    options.changeScope,
                ))
            )
                return;
        } catch (error) {
            if (!runtime.isActive() || memoryFailureCode(error) === "aborted")
                return;
            ctx.ui.notify(safeError(error), "error");
            if (!runtime.hasCurrentScope()) return;
        }
    }
}
