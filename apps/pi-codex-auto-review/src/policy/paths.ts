import { access, realpath } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { GuardError } from "../contracts.js";
import {
    isProtectedWithin,
    isRemoteWindowsPath,
    normalizeWindowsToolPath,
    pathModule,
    windowsMissingTailIssue,
    windowsPathIssue,
} from "./platform-paths.js";

export { isProtectedWithin, isRemoteWindowsPath };

export function isWithin(path: string, root: string): boolean {
    const rel = relative(root, path);
    return (
        rel === "" ||
        (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
    );
}
/** Pi file-input string normalization before resolution, including Windows shell drive paths. */
export function normalizeToolPathInput(
    input: string,
    homeDir: string,
    platform: NodeJS.Platform = process.platform,
): string {
    let path = input
        .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
        .replace(/^@/, "");
    if (platform === "win32") path = normalizeWindowsToolPath(path);
    if (path === "~") return homeDir;
    if (
        path.startsWith("~/") ||
        (platform === "win32" && path.startsWith("~\\"))
    )
        return pathModule(platform).join(homeDir, path.slice(2));
    if (path.startsWith("file://"))
        return fileURLToPath(path, { windows: platform === "win32" });
    return path;
}
/** File-system access and platform used for path resolution; tests inject Windows behavior. */
export interface PathHost {
    readonly platform: NodeJS.Platform;
    readonly realpath: (path: string) => Promise<string>;
    readonly access: (path: string) => Promise<void>;
    readonly hostname: () => string;
}
const LOCAL_HOST: PathHost = {
    platform: process.platform,
    realpath,
    access,
    hostname,
};
/** Pi 1.3 file-input semantics, including its screenshot filename variants. */
export async function resolveToolPath(
    input: string,
    cwd: string,
    isRead = false,
    homeDir = homedir(),
    host: PathHost = LOCAL_HOST,
): Promise<string> {
    if (typeof input !== "string" || input.includes("\0"))
        throw new GuardError("INVALID_PATH", "Invalid file input");
    const resolved = pathModule(host.platform).resolve(
        cwd,
        normalizeToolPathInput(input, homeDir, host.platform),
    );
    // Probing a remote share before approval would already contact it.
    if (!isRead || isRemoteWindowsPath(resolved, host.platform))
        return resolved;
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
            await host.access(candidate);
            return candidate;
        } catch {}
    }
    return resolved;
}
/**
 * Resolve existing ancestors as well as missing write targets, never just string prefixes.
 * Remote Windows UNC paths resolve lexically, without file-system access; policy treats
 * them as unbound targets.
 */
export async function canonicalPath(
    path: string,
    cwd: string,
    host: PathHost = LOCAL_HOST,
): Promise<string> {
    if (typeof path !== "string" || !path || path.includes("\0"))
        throw new GuardError("INVALID_PATH", "Invalid path");
    const paths = pathModule(host.platform);
    const absolute = paths.resolve(cwd, path);
    const isWindows = host.platform === "win32";
    const issue = isWindows
        ? (windowsPathIssue(path, [host.hostname()]) ??
          windowsPathIssue(absolute, [host.hostname()]))
        : undefined;
    if (issue) throw new GuardError("INVALID_PATH", issue);
    if (isRemoteWindowsPath(absolute, host.platform)) return absolute;
    let ancestor = absolute;
    for (;;) {
        try {
            const real = await host.realpath(ancestor),
                tail = paths.relative(ancestor, absolute);
            const tailIssue = isWindows
                ? windowsMissingTailIssue(tail)
                : undefined;
            if (tailIssue) throw new GuardError("INVALID_PATH", tailIssue);
            return paths.resolve(real, tail);
        } catch (error) {
            if (
                !["ENOENT", "ENOTDIR"].includes(
                    (error as NodeJS.ErrnoException).code ?? "",
                )
            )
                throw error;
            const parent = paths.dirname(ancestor);
            if (parent === ancestor)
                throw new GuardError("INVALID_PATH", "Cannot resolve path", {
                    cause: error,
                });
            ancestor = parent;
        }
    }
}
