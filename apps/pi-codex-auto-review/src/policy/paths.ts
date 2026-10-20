import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { GuardError } from "../contracts.js";

export function isWithin(path: string, root: string): boolean {
    const rel = relative(root, path);
    return (
        rel === "" ||
        (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
    );
}
/** Pi 0.99.1 file-input semantics, including its screenshot filename variants. */
export async function resolveToolPath(
    input: string,
    cwd: string,
    isRead = false,
    homeDir = homedir(),
): Promise<string> {
    if (typeof input !== "string" || input.includes("\0"))
        throw new GuardError("INVALID_PATH", "Invalid file input");
    let path = input
        .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
        .replace(/^@/, "");
    if (path === "~") path = homeDir;
    else if (path.startsWith("~/")) path = join(homeDir, path.slice(2));
    else if (path.startsWith("file://")) path = fileURLToPath(path);
    const resolved = resolve(cwd, path);
    if (!isRead) return resolved;
    const nfd = resolved.normalize("NFD");
    for (const candidate of [
        ...new Set([
            resolved,
            resolved.replace(/ (AM|PM)\./gi, "\u202F$1."),
            nfd,
            resolved.replace(/'/g, "\u2019"),
            nfd.replace(/'/g, "\u2019"),
        ]),
    ]) {
        try {
            await access(candidate);
            return candidate;
        } catch {}
    }
    return resolved;
}
/** Resolve existing ancestors as well as missing write targets, never just string prefixes. */
export async function canonicalPath(
    path: string,
    cwd: string,
): Promise<string> {
    if (typeof path !== "string" || !path || path.includes("\0"))
        throw new GuardError("INVALID_PATH", "Invalid path");
    const absolute = resolve(cwd, path);
    let ancestor = absolute;
    for (;;) {
        try {
            return resolve(
                await realpath(ancestor),
                relative(ancestor, absolute),
            );
        } catch (error) {
            if (
                !["ENOENT", "ENOTDIR"].includes(
                    (error as NodeJS.ErrnoException).code ?? "",
                )
            )
                throw error;
            const parent = dirname(ancestor);
            if (parent === ancestor)
                throw new GuardError("INVALID_PATH", "Cannot resolve path", {
                    cause: error,
                });
            ancestor = parent;
        }
    }
}
