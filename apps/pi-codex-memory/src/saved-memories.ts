import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    type Option,
    type OptionListSettings,
    pickOption,
    pickOptionWithQuery,
    type SettingRow,
} from "./menus.js";
import type { MemoryRuntime } from "./runtime.js";
import { truncateBytes } from "./safety.js";
import type { MemoryRecord } from "./store.js";

/** Memory titles get up to 60 columns before the kind and date. */
const MEMORY_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 64 };

/** The Saved memories row: its list opens in place, and a picked memory opens browseMemories. */
export function savedMemoriesRow(runtime: MemoryRuntime): SettingRow {
    return {
        id: "memories",
        label: "Saved memories",
        value: String(runtime.store.records(runtime.scope).length),
        description:
            "Search, view, edit or forget saved memories. Does not call a model.",
        options: () => memoryList(runtime),
    };
}
function recordTitle(record: MemoryRecord): string {
    const line =
        record.body
            .split("\n")
            .map((text) => text.replace(/^#+\s*/, "").trim())
            .find(Boolean) ?? record.path;
    return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
function memoryList(runtime: MemoryRuntime, settings: OptionListSettings = {}) {
    const options = memoryOptions(runtime);
    return {
        title: "Saved memories",
        description: runtime.scopeName(),
        options,
        ...settings,
        isSearchable: options.some((option) => option.value),
        layout: MEMORY_LAYOUT,
    };
}
/**
 * Opens one memory after another: after viewing, editing or forgetting a memory, or leaving its
 * actions with Esc, the list opens again with the same filter, on that memory. Esc in the list
 * returns to the settings page.
 */
export async function browseMemories(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
    path: string,
    query: string | undefined,
): Promise<void> {
    let current: string | undefined = path;
    let filter = query;
    while (current) {
        const next = await editRecord(runtime, ctx, current);
        if (!runtime.hasCurrentScope()) return;
        const { title, description, options, ...settings } = memoryList(
            runtime,
            { preselect: next, query: filter },
        );
        const picked = await pickOptionWithQuery(
            ctx,
            title,
            description,
            options,
            settings,
        );
        if (!picked?.value) return;
        current = picked.value;
        filter = picked.query;
    }
}
function memoryOptions(runtime: MemoryRuntime): Option[] {
    const records = runtime.store.records(runtime.scope);
    if (!records.length)
        return [
            {
                value: "",
                label: "No saved memories yet",
                description: "Turn memory on in /codex-memory",
            },
        ];
    return records.map((record) => ({
        value: record.path,
        label: recordTitle(record),
        description: `${record.kind === "note" ? "Note" : "From a conversation"} · ${new Date(record.generatedAtMs).toISOString().slice(0, 10)}`,
        searchText: `${record.path} ${record.body}`,
    }));
}
/** Shows a memory's actions and returns the memory the list should highlight next. */
async function editRecord(
    runtime: MemoryRuntime,
    ctx: ExtensionContext,
    path: string,
): Promise<string | undefined> {
    const record = runtime.store
        .records(runtime.scope)
        .find((item) => item.path === path);
    if (!record) return undefined;
    const action = await pickOption(ctx, recordTitle(record), record.path, [
        {
            value: "view",
            label: "View memory and source",
            description: "Read-only",
        },
        {
            value: "edit",
            label: "Edit memory",
            description: "Kept even when unused",
        },
        {
            value: "forget",
            label: "Forget memory",
            description: "Its conversation will not create it again",
        },
    ]);
    if (action === "view")
        await ctx.ui.editor(
            `${record.path} (read-only, changes are not saved)`,
            runtime.store.document(record),
        );
    else if (action === "edit") {
        const body = await ctx.ui.editor(`Edit ${record.path}`, record.body);
        if (!body?.trim() || body === record.body) return path;
        if (
            !(await ctx.ui.confirm(
                "Save this change?",
                truncateBytes(body, 4000),
            ))
        )
            return path;
        await runtime.cancel();
        // An edited memory becomes a note with its own path.
        const notePath = runtime.store.revise(runtime.scope, record.path, body);
        ctx.ui.notify("Memory updated.", "info");
        return notePath;
    } else if (action === "forget") {
        if (
            !(await ctx.ui.confirm(
                "Forget this memory?",
                "It is removed from memory and its summaries, and the conversation it came from will not create it again. Your Pi sessions and anything already sent to a provider are not deleted.",
            ))
        )
            return path;
        const order = memoryOptions(runtime).map((option) => option.value);
        const index = order.indexOf(path);
        await runtime.cancel();
        runtime.store.revise(runtime.scope, record.path, null);
        ctx.ui.notify("Memory forgotten.", "info");
        return order[index + 1] ?? order[index - 1];
    }
    return path;
}
