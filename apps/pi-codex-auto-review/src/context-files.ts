import {
    closeSync,
    constants,
    fstatSync,
    openSync,
    readSync,
    realpathSync,
    statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { GuardError, type PermissionProfile } from "./contracts.js";
import type { GuardSettings } from "./policy/index.js";
import { isWithin } from "./policy/paths.js";

export interface ContextFile {
    readonly path: string;
    readonly content: string;
}
const NAMES = ["AGENTS.override.md", "AGENTS.md"];
function isMissing(error: unknown): boolean {
    return ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
    );
}
function isFilename(name: string): boolean {
    return (
        !!name &&
        ![".", ".."].includes(name) &&
        !name.includes("\0") &&
        basename(name) === name &&
        (process.platform !== "win32" || !/[\\:]/.test(name))
    );
}
function exists(path: string): boolean {
    try {
        statSync(path);
        return true;
    } catch (error) {
        if (isMissing(error)) return false;
        throw error;
    }
}
function choose(
    directory: string,
    names: readonly string[],
): string | undefined {
    for (const name of names) {
        const path = join(directory, name);
        try {
            if (statSync(path).isFile()) return path;
        } catch (error) {
            if (!isMissing(error)) throw error;
        }
    }
}
function boundedRead(
    path: string,
    maxBytes: number,
    profile: PermissionProfile,
    isGlobal: boolean,
    agentDir: string,
): { file: ContextFile; bytesRead: number } | undefined {
    const target = realpathSync(path);
    // Only the specifically selected global instruction file is an internal controller read.
    const isGlobalInstruction =
        isGlobal &&
        target === join(realpathSync(agentDir), basename(path)) &&
        NAMES.includes(basename(path));
    if (
        !isGlobalInstruction &&
        (profile.denyRead.some((root) => isWithin(target, root)) ||
            !profile.readRoots.some((root) => isWithin(target, root)))
    ) {
        throw new GuardError(
            "CONTEXT_FILE_DENIED",
            `Instruction file crosses a protected read boundary: ${path}`,
        );
    }
    const expected = statSync(target);
    if (!expected.isFile() || expected.nlink > 1)
        throw new GuardError(
            "CONTEXT_FILE_DENIED",
            "Instruction file must be a regular file without hard-link aliases",
        );
    const fd = openSync(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
        const actual = fstatSync(fd);
        if (
            !actual.isFile() ||
            actual.dev !== expected.dev ||
            actual.ino !== expected.ino ||
            actual.nlink > 1 ||
            realpathSync(path) !== target
        )
            throw new GuardError(
                "CONTEXT_FILE_CHANGED",
                "Instruction file changed during loading",
            );
        const data = Buffer.alloc(Math.min(actual.size, maxBytes));
        let count = 0;
        while (count < data.length) {
            const read = readSync(fd, data, count, data.length - count, count);
            if (!read) break;
            count += read;
        }
        const content = data.subarray(0, count).toString("utf8");
        return content.trim()
            ? { file: { path, content }, bytesRead: count }
            : undefined;
    } finally {
        closeSync(fd);
    }
}

/** Codex a956835d/core/src/agents_md.rs precedence, traversal and aggregate byte budget. */
export function loadContextFiles(options: {
    cwd: string;
    agentDir: string;
    profile: PermissionProfile;
    settings: GuardSettings;
    isProjectTrusted: boolean;
}): ContextFile[] {
    const { settings, profile } = options;
    const result: ContextFile[] = [];
    // The host's agent directory is the Pi equivalent of Codex's instruction home.
    for (const name of NAMES) {
        const global = choose(options.agentDir, [name]);
        if (!global) continue;
        const file = boundedRead(
            global,
            32768,
            profile,
            true,
            options.agentDir,
        );
        if (file) {
            result.push(file.file);
            break;
        }
    }
    if (!options.isProjectTrusted || settings.projectDocMaxBytes === 0)
        return result;
    const cwd = resolve(options.cwd),
        markers = (settings.projectRootMarkers ?? [".git"]).filter(isFilename);
    let root: string | undefined;
    for (let dir = cwd; markers.length; dir = dirname(dir)) {
        if (markers.some((name) => exists(join(dir, name)))) {
            root = dir;
            break;
        }
        if (dirname(dir) === dir) break;
    }
    const directories = [cwd];
    if (root)
        for (let dir = cwd; dir !== root; ) {
            dir = dirname(dir);
            directories.unshift(dir);
        }
    const names = [
        ...new Set([
            ...NAMES,
            ...settings.projectDocFallbackFilenames.filter(isFilename),
        ]),
    ];
    let remaining = settings.projectDocMaxBytes;
    for (const directory of directories) {
        if (!remaining) break;
        const path = choose(directory, names);
        if (!path || result.some((file) => file.path === path)) continue;
        const file = boundedRead(
            path,
            remaining,
            profile,
            false,
            options.agentDir,
        );
        if (file) {
            result.push(file.file);
            remaining = Math.max(0, remaining - file.bytesRead);
        }
    }
    return result;
}
