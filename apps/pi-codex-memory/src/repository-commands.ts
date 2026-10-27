import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryUserError } from "./failure.js";
import { type Option, type OptionListSettings, pickOption } from "./menus.js";
import {
    findRepository,
    type RegisteredRepository,
    type RepositoryLocation,
} from "./repositories.js";
import { abortable } from "./safety.js";
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
    >;
    readonly scope: string;
    readonly cwd: string;
    readonly signal: AbortSignal;
}

/** The option that adds a repository by its path. */
export const ADD_REPOSITORY = "+add";
const ALWAYS = "always";
const ASK = "ask";
const ACCESS_LABELS = {
    [ALWAYS]: "Always allow reads",
    [ASK]: "Ask each time",
};

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
        pick: (
            title: string,
            description: string,
            options: readonly Option[],
            settings: OptionListSettings = {},
        ) =>
            abortable(
                pickOption(ctx, title, description, options, {
                    ...settings,
                    signal,
                }),
                signal,
            ),
        input: (title: string, placeholder: string) =>
            abortable(ctx.ui.input(title, placeholder, { signal }), signal),
        confirm: (title: string, text: string) =>
            abortable(ctx.ui.confirm(title, text, { signal }), signal),
    };
}
function location(repository: RegisteredRepository): string {
    return repository.worktreeRoots[0] ?? repository.commonDirectory;
}
function otherRepositories(memory: RepositoryCommandContext) {
    return memory.store
        .repositories()
        .filter((repository) => repository.scope !== memory.scope);
}
function access(memory: RepositoryCommandContext, scope: string) {
    return memory.store.readLink(memory.scope, scope).isEnabled ? ALWAYS : ASK;
}
export function repositorySummary(memory: RepositoryCommandContext): string {
    const count = otherRepositories(memory).length;
    return count ? `${count} added` : "none";
}
/** The repository list that /codex-memory-settings opens in place. */
export function repositoryOptions(memory: RepositoryCommandContext): {
    title: string;
    description: string;
    options: Option[];
} {
    return {
        title: "Other repositories",
        description:
            "Repositories whose memories the agent may read from here. Access goes one way.",
        options: [
            ...otherRepositories(memory).map((repository) => ({
                value: repository.scope,
                label: repository.name,
                description: `${ACCESS_LABELS[access(memory, repository.scope)]} · ${location(repository)}`,
            })),
            {
                value: ADD_REPOSITORY,
                label: "+ Add repository",
                description: "Add a repository by its folder path",
            },
        ],
    };
}
/** Changes read access to a listed repository, or adds one by path; each change is confirmed. */
export async function editRepository(
    memory: RepositoryCommandContext,
    ctx: ExtensionContext,
    value: string,
): Promise<void> {
    const ui = management(memory, ctx);
    let found: RepositoryLocation | undefined;
    let repository = otherRepositories(memory).find(
        (item) => item.scope === value,
    );
    if (value === ADD_REPOSITORY) {
        const path = await ui.input(
            "Repository folder (absolute path)",
            "/path/to/repository",
        );
        if (!path) return;
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
    if (!repository) return;
    const current = access(memory, repository.scope);
    // Pi marks the current value of a short list with ✓.
    const state = await ui.pick(
        repository.name,
        location(repository),
        [
            {
                value: ALWAYS,
                label: `${current === ALWAYS ? "✓ " : "  "}${ACCESS_LABELS[ALWAYS]}`,
                description: "The agent reads its memories without asking",
            },
            {
                value: ASK,
                label: `${current === ASK ? "✓ " : "  "}${ACCESS_LABELS[ASK]}`,
                description:
                    "The agent asks before each request that reads them",
            },
        ],
        { preselect: current },
    );
    if (!state) return;
    const changesLink = state !== current;
    if (!found && !changesLink) return;
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
    if (!confirmed) return;
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
    ctx.ui.notify(
        `${repository.name}: ${ACCESS_LABELS[state as keyof typeof ACCESS_LABELS]}.`,
        "info",
    );
}
