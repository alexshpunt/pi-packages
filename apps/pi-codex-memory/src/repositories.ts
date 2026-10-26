import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalCwd, digest, workspaceScope } from "./safety.js";

export interface RepositoryLocation {
    scope: string;
    name: string;
    commonDirectory: string;
    worktreeRoot: string;
    gitDirectory: string;
}
export interface RegisteredRepository {
    scope: string;
    name: string;
    commonDirectory: string;
    worktreeRoots: string[];
    sessionDirectories: string[];
}
export interface RepositoryObservation {
    scope: string;
    commonDirectory: string;
    worktreeRoot: string;
    branchAtCapture: string | null;
    capturedAtMs: number;
    binding: "session_start" | "current_location";
}
function metadata(path: string): string {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Unsupported Git metadata file.");
    return readFileSync(path, "utf8").replace(/\r?\n$/, "");
}
export function repositoryScope(commonDirectory: string): string {
    return "repository-" + digest(canonicalCwd(commonDirectory)).slice(0, 24);
}
/** Read only Git location metadata; do not invoke hooks, read remotes, or change the repository. */
export function findRepository(cwd: string): RepositoryLocation | undefined {
    let root = canonicalCwd(cwd);
    while (true) {
        const marker = join(root, ".git");
        let stat;
        try { stat = lstatSync(marker); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
        if (stat) {
            try {
                const pointer = stat.isFile() && !stat.isSymbolicLink() ? /^gitdir: ([^\r\n\0]+)$/.exec(metadata(marker))?.[1] : undefined;
                const gitDirectory = realpathSync(stat.isDirectory() ? marker : pointer ? resolve(root, pointer) : "\0");
                // HEAD establishes a working Git directory; its content is not used as a scope key.
                if (!/^(?:ref: refs\/[^\r\n\0]+|[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(metadata(join(gitDirectory, "HEAD")))) return undefined;
                let common = gitDirectory;
                try {
                    const pointer = metadata(join(gitDirectory, "commondir"));
                    if (!pointer || /[\r\n\0]/.test(pointer)) return undefined;
                    common = resolve(gitDirectory, pointer);
                }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
                const commonDirectory = realpathSync(common);
                if (!lstatSync(commonDirectory).isDirectory() || !lstatSync(join(commonDirectory, "config")).isFile()) return undefined;
                return { scope: repositoryScope(commonDirectory),
                    name: (basename(commonDirectory) === ".git" ? basename(dirname(commonDirectory)) : basename(commonDirectory).replace(/\.git$/, "")) || "repository",
                    commonDirectory, worktreeRoot: root, gitDirectory };
            } catch { return undefined; } // Never ascend past an invalid nested Git boundary.
        }
        const parent = dirname(root);
        if (parent === root) return undefined;
        root = parent;
    }
}
export function defaultMemoryScope(cwd: string): string {
    return findRepository(cwd)?.scope ?? workspaceScope(cwd);
}
export function observeRepository(cwd: string, binding: RepositoryObservation["binding"] = "current_location"): RepositoryObservation | undefined {
    const repository = findRepository(cwd);
    if (!repository) return undefined;
    let branchAtCapture: string | null = null;
    try { branchAtCapture = /^ref: refs\/heads\/([^\r\n]+)$/.exec(metadata(join(repository.gitDirectory, "HEAD")))?.[1] ?? null; } catch {}
    return { scope: repository.scope, commonDirectory: repository.commonDirectory, worktreeRoot: repository.worktreeRoot,
        branchAtCapture, capturedAtMs: Date.now(), binding };
}
export function repositoryPath(path: string): { scope: string; path: string } | undefined {
    if (!path.startsWith("repositories/")) return undefined;
    const match = /^repositories\/(repository-[a-f0-9]{24})(?:\/(.*))?$/.exec(path);
    if (!match) throw new Error("Invalid repository-qualified memory path.");
    return { scope: match[1]!, path: match[2] ?? "" };
}
export function repositoryLabel(repository: RegisteredRepository): string {
    return `${JSON.stringify(repository.name)} · ${repository.scope} · ${JSON.stringify(repository.commonDirectory)}`;
}
