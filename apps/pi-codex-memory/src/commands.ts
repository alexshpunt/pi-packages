import type {
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type MemoryMode, memoryMode } from "./config.js";
import { memoryFailureCode } from "./failure.js";
import type { PipelineResult } from "./pipeline.js";
import {
    importLegacyMemories,
    legacyMemoryCount,
    type RepositoryCommandContext,
} from "./repository-commands.js";
import type { MemoryRuntime } from "./runtime.js";
import { safeError, truncateBytes } from "./safety.js";
import { enableCreation, modelText } from "./settings-commands.js";
import type { MemoryRecord } from "./store.js";

export interface CommandOptions {
    ctx: ExtensionCommandContext;
    runtime: MemoryRuntime;
    repositories: RepositoryCommandContext;
    show: (text: string) => void;
}

const MODES: readonly (readonly [Exclude<MemoryMode, "custom">, string])[] = [
    ["off", "Off"],
    ["use", "Use saved memories"],
    ["create", "Use and create memories"],
];

/** `/codex-memory`: choose whether memory is off, used, or used and created. */
export async function modeCommand({
    ctx,
    runtime,
    show,
}: CommandOptions): Promise<void> {
    if (!ctx.hasUI) {
        show(JSON.stringify(runtime.status(), null, 2));
        return;
    }
    const settings = runtime.settings();
    const current = memoryMode(settings);
    const count = runtime.store.records(runtime.scope).length;
    const title = [
        `Codex Memory · ${runtime.scopeName()} · ${count} saved${current === "custom" ? " · custom settings" : ""}`,
        "Saved memories: /codex-memory-manage · Settings: /codex-memory-settings",
    ].join("\n");
    const rows = MODES.map(
        ([mode, label]) => `${mode === current ? "(•)" : "( )"} ${label}`,
    );
    const choice = await ctx.ui.select(title, [...rows, "Close"]);
    const mode = MODES[rows.indexOf(choice ?? "")]?.[0];
    if (!mode || mode === current) return;
    try {
        if (mode === "create") {
            await enableCreation(runtime, ctx);
            return;
        }
        await runtime.saveSettings({
            ...settings,
            useMemories: mode === "use",
            generateMemories: false,
        });
        ctx.ui.notify(
            mode === "off"
                ? "Memory is off. Saved memories are kept."
                : "Memory creation is off. Saved memories are still used.",
            "info",
        );
    } catch (error) {
        ctx.ui.notify(safeError(error), "error");
    }
}
function recordLabel(record: MemoryRecord): string {
    const line =
        record.body
            .split("\n")
            .map((text) => text.replace(/^#+\s*/, "").trim())
            .find(Boolean) ?? "";
    const preview = line.length > 60 ? `${line.slice(0, 59)}…` : line;
    return `${preview} · ${record.path}`;
}
async function reviewRecord(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
    record: MemoryRecord,
): Promise<void> {
    const action = await ctx.ui.select(record.path, [
        "View memory and source",
        "Edit memory",
        "Forget memory",
        "Back",
    ]);
    if (action === "View memory and source")
        await ctx.ui.editor(
            `${record.path} (read-only, changes are not saved)`,
            runtime.store.document(record),
        );
    else if (action === "Edit memory") {
        const body = await ctx.ui.editor(`Edit ${record.path}`, record.body);
        if (!body?.trim() || body === record.body) return;
        if (
            !(await ctx.ui.confirm(
                "Save this change?",
                truncateBytes(body, 4000),
            ))
        )
            return;
        await runtime.cancel();
        runtime.store.revise(runtime.scope, record.path, body);
        ctx.ui.notify("Memory updated.", "info");
    } else if (action === "Forget memory") {
        if (
            !(await ctx.ui.confirm(
                "Forget this memory?",
                "It is removed from memory and its summaries, and the conversation it came from will not create it again. Your Pi sessions and anything already sent to a provider are not deleted.",
            ))
        )
            return;
        await runtime.cancel();
        runtime.store.revise(runtime.scope, record.path, null);
        ctx.ui.notify("Memory forgotten.", "info");
    }
}
async function review(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
): Promise<void> {
    let query = "";
    while (true) {
        const records = runtime.store
            .records(runtime.scope)
            .filter(
                (record) =>
                    !query ||
                    record.body.toLowerCase().includes(query.toLowerCase()) ||
                    record.path.includes(query),
            );
        const labels = records.map(recordLabel);
        const choice = await ctx.ui.select(
            query
                ? `Memories matching "${query}" · ${records.length}`
                : `Saved memories · ${records.length}`,
            ["Search…", ...labels, "Back"],
        );
        if (!choice || choice === "Back") return;
        if (choice === "Search…") {
            const value = await ctx.ui.input("Search memories", "Text to find");
            if (value !== undefined) query = value.trim();
            continue;
        }
        const record = records[labels.indexOf(choice)];
        if (record) await reviewRecord(runtime, ctx, record);
    }
}
function resultText(result: PipelineResult): string {
    if (result.failed)
        return `Memory creation failed for ${result.failed} conversation(s). Open /codex-memory-manage and choose Show what failed.`;
    if (result.extracted)
        return `Created memories from ${result.extracted} conversation(s).`;
    return "No new memories were created.";
}
/**
 * Starts extraction of the current branch; in the TUI it keeps running after the menu closes.
 * Returns false when the user declines.
 */
async function generate(
    runtime: MemoryRuntime,
    ctx: ExtensionCommandContext,
): Promise<boolean> {
    if (
        !(await ctx.ui.confirm(
            "Create memories from this conversation now?",
            `Pi masks a copy of this conversation and sends it to ${modelText(runtime.settings())}. This uses your provider quota or costs money, and counts toward today's model calls.`,
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
        "Creating memories from this conversation. To stop, open /codex-memory-manage.",
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
/** `/codex-memory-manage`: saved memories and the jobs that create them. */
export async function manageCommand({
    ctx,
    runtime,
    repositories,
    show,
}: CommandOptions): Promise<void> {
    if (!ctx.hasUI) {
        show(JSON.stringify(runtime.status(), null, 2));
        return;
    }
    while (true) {
        const legacy = legacyMemoryCount(repositories);
        const legacyRow = `Import ${legacy} old memories for this folder`;
        const rows = [
            `Review saved memories (${runtime.store.records(runtime.scope).length})`,
            ...(runtime.isRunning
                ? ["Stop current job"]
                : runtime.settings().generateMemories
                  ? ["Generate from this conversation"]
                  : []),
            ...(legacy ? [legacyRow] : []),
            ...(runtime.failure ? ["Show what failed"] : []),
            "Forget all memories in this scope",
            "Close",
        ];
        const choice = await ctx.ui.select(
            `Saved memories · ${runtime.scopeName()}`,
            rows,
        );
        if (!choice || choice === "Close") return;
        try {
            if (choice === rows[0]) await review(runtime, ctx);
            else if (choice === "Generate from this conversation") {
                if (await generate(runtime, ctx)) return;
            } else if (choice === "Stop current job") {
                await runtime.cancel();
                ctx.ui.notify("Stopped the memory job.", "info");
            } else if (choice === legacyRow)
                await importLegacyMemories(repositories, ctx);
            else if (choice === "Show what failed") {
                show(JSON.stringify(runtime.status(), null, 2));
                return;
            } else if (choice === "Forget all memories in this scope")
                await forgetAll(runtime, ctx);
        } catch (error) {
            ctx.ui.notify(safeError(error), "error");
        }
    }
}
