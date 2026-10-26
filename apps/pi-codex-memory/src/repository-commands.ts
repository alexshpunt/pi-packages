import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryUserError } from "./failure.js";
import {
    findRepository,
    type RegisteredRepository,
    type RepositoryLocation,
} from "./repositories.js";
import { abortable, truncateBytes } from "./safety.js";
import type { MemoryStore } from "./store.js";

export interface RepositoryCommandContext {
    readonly store: Pick<
        MemoryStore,
        | "scopeFor"
        | "repositories"
        | "repository"
        | "readLink"
        | "registerRepository"
        | "setReadLink"
        | "legacyMemories"
        | "state"
        | "document"
        | "importLegacy"
    >;
    readonly scope: string;
    readonly cwd: string;
    readonly repositoryScope: string | undefined;
    readonly signal: AbortSignal;
    /** Stops a running memory job before a change that a job would conflict with. */
    readonly cancel: () => Promise<void>;
}

const ALWAYS = "Always allow reads";
const ASK = "Ask each time";

function management(memory: RepositoryCommandContext, ctx: ExtensionContext) {
    if (!ctx.hasUI)
        throw new MemoryUserError(
            "Repository changes need a confirmation dialog.",
        );
    const signal = AbortSignal.any([
        memory.signal,
        ...(ctx.signal ? [ctx.signal] : []),
    ]);
    const check = () => {
        signal.throwIfAborted();
        if (memory.store.scopeFor(memory.cwd) !== memory.scope)
            throw new MemoryUserError(
                "The memory scope changed. Open the menu again.",
            );
    };
    check();
    return {
        check,
        select: (title: string, rows: string[]) =>
            abortable(ctx.ui.select(title, rows, { signal }), signal),
        input: (title: string, placeholder: string) =>
            abortable(ctx.ui.input(title, placeholder, { signal }), signal),
        confirm: (title: string, text: string) =>
            abortable(ctx.ui.confirm(title, text, { signal }), signal),
    };
}
function location(repository: RegisteredRepository): string {
    return repository.worktreeRoots[0] ?? repository.commonDirectory;
}
/** Old per-folder memories that can be imported into the current repository scope. */
export function legacyMemoryCount(memory: RepositoryCommandContext): number {
    if (!memory.repositoryScope || memory.scope !== memory.repositoryScope)
        return 0;
    return memory.store.legacyMemories(memory.cwd).records.length;
}
/** Lists other repositories with their read state; changing a state needs a confirmation. */
export async function editRepositoryAccess(
    memory: RepositoryCommandContext,
    ctx: ExtensionContext,
): Promise<void> {
    const ui = management(memory, ctx);
    while (true) {
        const repositories = memory.store
            .repositories()
            .filter((repository) => repository.scope !== memory.scope);
        const labels = repositories.map(
            (repository) =>
                `${repository.name} (${location(repository)}): ${
                    memory.store.readLink(memory.scope, repository.scope)
                        .isEnabled
                        ? ALWAYS
                        : ASK
                }`,
        );
        const choice = await ui.select("Repository access", [
            ...labels,
            "Add repository…",
            "Back",
        ]);
        if (!choice || choice === "Back") return;
        ui.check();
        let found: RepositoryLocation | undefined;
        let repository = repositories[labels.indexOf(choice)];
        if (choice === "Add repository…") {
            const path = await ui.input(
                "Repository folder (absolute path)",
                "/path/to/repository",
            );
            if (!path) continue;
            if (!isAbsolute(path))
                throw new MemoryUserError(
                    "Enter an absolute path to the repository folder.",
                );
            found = findRepository(path);
            if (!found)
                throw new MemoryUserError(
                    "No Git repository was found at that path.",
                );
            if (found.scope === memory.scope)
                throw new MemoryUserError(
                    "That is the repository you are working in.",
                );
            repository = memory.store.repository(found.scope) ?? {
                scope: found.scope,
                name: found.name,
                commonDirectory: found.commonDirectory,
                worktreeRoots: [found.worktreeRoot],
                sessionDirectories: [],
            };
        }
        if (!repository) continue;
        const isEnabled = memory.store.readLink(
            memory.scope,
            repository.scope,
        ).isEnabled;
        const state = await ui.select(repository.name, [ALWAYS, ASK, "Back"]);
        if (!state || state === "Back") continue;
        const changesLink = (state === ALWAYS) !== isEnabled;
        if (!found && !changesLink) continue;
        const confirmed =
            state === ALWAYS
                ? await ui.confirm(
                      `Always allow reading ${repository.name}'s memory?`,
                      `The agent can read ${repository.name}'s memory from here without asking. This works in one direction only: ${repository.name} cannot read this repository's memory. Its memories are never copied, changed or added to the summary.`,
                  )
                : await ui.confirm(
                      `Ask before each read of ${repository.name}'s memory?`,
                      "The agent asks you each time it needs this repository's memory. Anything already shown in this conversation stays there.",
                  );
        if (!confirmed) continue;
        ui.check();
        if (found) {
            if (findRepository(found.worktreeRoot)?.scope !== found.scope)
                throw new MemoryUserError(
                    "The repository moved during confirmation. Add it again.",
                );
            memory.store.registerRepository(found);
        }
        if (changesLink)
            memory.store.setReadLink(
                memory.scope,
                repository.scope,
                state === ALWAYS,
            );
        ctx.ui.notify(`${repository.name}: ${state}.`, "info");
    }
}
/** Copies every memory saved for this folder before repository scopes existed. */
export async function importLegacyMemories(
    memory: RepositoryCommandContext,
    ctx: ExtensionContext,
): Promise<void> {
    const ui = management(memory, ctx);
    if (!memory.repositoryScope || memory.scope !== memory.repositoryScope)
        throw new MemoryUserError(
            "Old folder memories can be imported only into a repository scope.",
        );
    const legacy = memory.store.legacyMemories(memory.cwd, memory.scope);
    if (!legacy.records.length)
        throw new MemoryUserError("This folder has no old memories to import.");
    const targetRevision = memory.store.state(memory.scope).revision;
    const notice = [
        `Copies ${legacy.records.length} memories saved for ${memory.cwd} into this repository's memory. The originals stay where they are, and later changes are not synced. Settings are not copied.`,
        ...(legacy.affectedPaths.length
            ? [
                  `${legacy.affectedPaths.length} memories in this repository come from conversations forgotten in the folder and are removed.`,
              ]
            : []),
        "",
        truncateBytes(
            [
                ...legacy.records.map((record) => record.path),
                ...legacy.affectedPaths.map((path) => `Removed: ${path}`),
            ].join("\n"),
            6000,
        ),
    ].join("\n");
    if (
        !(await ui.confirm(
            `Import ${legacy.records.length} old memories for this folder?`,
            notice,
        ))
    )
        return;
    ui.check();
    await memory.cancel();
    const result = memory.store.importLegacy(
        memory.cwd,
        memory.scope,
        legacy.records.map((record) => record.id),
        legacy.revision,
        targetRevision,
    );
    ctx.ui.notify(
        `Imported ${result.imported} memories, skipped ${result.skipped}, removed ${result.removed}.`,
        "info",
    );
}
