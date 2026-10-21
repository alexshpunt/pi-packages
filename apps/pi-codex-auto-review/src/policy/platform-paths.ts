import path from "node:path";

/** Path semantics of a host platform; Windows behavior is testable on every host. */
export function pathModule(platform: NodeJS.Platform): typeof path.posix {
    return platform === "win32" ? path.win32 : path.posix;
}

/** Windows resolves executables case-insensitively and through PATHEXT suffixes. */
export function executableName(
    raw: string,
    platform: NodeJS.Platform = process.platform,
): string {
    return platform === "win32"
        ? raw
              .replace(/[A-Z]/g, (char) => char.toLowerCase())
              .replace(/\.(exe|cmd|bat|com)$/, "")
        : raw;
}

/** The program name a shell word invokes, without its directory. */
export function commandName(
    program: string,
    platform: NodeJS.Platform = process.platform,
): string {
    return executableName(pathModule(platform).basename(program), platform);
}

export function isWithinFor(
    platform: NodeJS.Platform,
    target: string,
    root: string,
): boolean {
    const paths = pathModule(platform);
    const rel = paths.relative(root, target);
    return (
        rel === "" ||
        (!rel.startsWith(`..${paths.sep}`) &&
            rel !== ".." &&
            !paths.isAbsolute(rel))
    );
}

/**
 * APFS (default) compares names case- and normalization-insensitively and NTFS
 * case-insensitively. Protection checks fold both sides so a differently spelled
 * missing component cannot alias a protected path; allow checks stay exact.
 */
export function protectedPathKey(
    target: string,
    platform: NodeJS.Platform = process.platform,
): string {
    if (platform === "darwin")
        return target.normalize("NFD").toUpperCase().normalize("NFD");
    if (platform === "win32") return target.toUpperCase();
    return target;
}

/** Containment for deny and review boundaries; over-matches rather than under-matches. */
export function isProtectedWithin(
    target: string,
    root: string,
    platform: NodeJS.Platform = process.platform,
): boolean {
    return isWithinFor(
        platform,
        protectedPathKey(target, platform),
        protectedPathKey(root, platform),
    );
}

/** A `.git` directory component before the last one, as in linked worktree gitdirs. */
export function hasInnerGitComponent(
    target: string,
    platform: NodeJS.Platform = process.platform,
): boolean {
    const gitName = protectedPathKey(".git", platform);
    return target
        .split(platform === "win32" ? /[\\/]/ : "/")
        .slice(0, -1)
        .some((component) => protectedPathKey(component, platform) === gitName);
}

/**
 * A UNC path to another host (`\\host\share`). Resolving it on Windows opens an SMB
 * connection, which can send NTLM credentials, so policy never touches it before approval.
 */
export function isRemoteWindowsPath(
    target: string,
    platform: NodeJS.Platform = process.platform,
): boolean {
    return (
        platform === "win32" &&
        /^[\\/]{2}(?![?.](?:[\\/]|$))[^\\/]/.test(target)
    );
}

const RESERVED_DEVICE =
    /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$|clock\$)$/i;
const LOOPBACK_HOST =
    /^(?:localhost|127(?:[.-]\d{1,3}){3}|0(?:[.-]0){3}|\[?::1\]?|0--1\.ipv6-literal\.net)$/i;

/**
 * Windows spellings whose target cannot be compared as a plain path: device
 * namespaces, drive-relative paths, alternate data streams, reserved device names
 * and administrative or loopback UNC shares that can alias local files.
 */
export function windowsPathIssue(
    input: string,
    localHostNames: readonly string[] = [],
): string | undefined {
    if (/^[\\/]{2}[?.](?:[\\/]|$)/.test(input) || /^\\\?\?\\/.test(input))
        return "Windows device namespace paths are not supported";
    if (/^[a-z]:(?![\\/])/i.test(input))
        return "Drive-relative Windows paths are not supported";
    const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(input);
    if (unc) {
        const host = unc[1].toLowerCase(),
            share = unc[2];
        if (
            LOOPBACK_HOST.test(host) ||
            localHostNames.some((name) => name.toLowerCase() === host) ||
            share.endsWith("$")
        )
            return "Loopback and administrative shares can alias local paths";
    }
    if (input.replace(/^[a-z]:/i, "").includes(":"))
        return "Alternate data streams and provider paths are not supported";
    for (const component of input.split(/[\\/]+/)) {
        const stem = component
            .replace(/[. ]+$/, "")
            .split(".")[0]
            .trimEnd();
        if (RESERVED_DEVICE.test(stem))
            return "Reserved Windows device names are not supported";
    }
    return undefined;
}

/**
 * Missing components are compared as typed, but Windows trims trailing dots and
 * spaces and resolves 8.3 short names when they are created or opened later.
 */
export function windowsMissingTailIssue(tail: string): string | undefined {
    for (const component of tail.split(/[\\/]+/)) {
        if (!component || component === "." || component === "..") continue;
        if (/[. ]$/.test(component))
            return "Windows trims trailing dots and spaces from path components";
        if (/~\d/.test(component))
            return "Windows short names in missing path components are not supported";
    }
    return undefined;
}

/** Windows spelling of Pi's file-tool input normalization (Git Bash, MSYS, Cygwin and WSL drives). */
export function normalizeWindowsToolPath(input: string): string {
    if (
        !input.startsWith("/") ||
        input.startsWith("//") ||
        input.includes("\\")
    )
        return input;
    const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(input);
    if (!match) return input;
    return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

/** The POSIX runtime a Windows bash executable maps paths through. */
export type BashFlavor = "posix" | "msys" | "cygwin" | "wsl" | "unknown";

export function bashFlavor(
    shellPath: string,
    platform: NodeJS.Platform = process.platform,
): BashFlavor {
    if (platform !== "win32") return "posix";
    const normalized = shellPath.replace(/\//g, "\\").toLowerCase();
    if (
        /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(
            normalized,
        ) ||
        normalized.includes("\\windowsapps\\") ||
        /(?:^|\\)wsl(?:\.exe)?$/.test(normalized)
    )
        return "wsl";
    if (normalized.includes("\\cygwin")) return "cygwin";
    if (/\\(?:git|msys[^\\]*|mingw[^\\]*)\\/.test(normalized)) return "msys";
    return "unknown";
}

/**
 * The Windows location a bash operand on a Windows host names. `isExact` is false
 * when only protection checks may use the mapping; undefined means unknown.
 * An unidentified shell is treated as possibly MSYS for protection, never for allows.
 */
export function windowsBashOperandPath(
    operand: string,
    cwd: string,
    flavor: Exclude<BashFlavor, "posix">,
): { readonly path: string; readonly isExact: boolean } | undefined {
    if (/^[a-z]:[\\/]/i.test(operand))
        // WSL treats a Windows drive path as a relative file name.
        return flavor === "wsl"
            ? undefined
            : {
                  path: path.win32.resolve(operand),
                  isExact: flavor !== "unknown",
              };
    if (/^(?:\\|[a-z]:)/i.test(operand)) return undefined;
    if (!operand.startsWith("/"))
        return { path: path.win32.resolve(cwd, operand), isExact: true };
    if (operand.startsWith("//") || flavor === "wsl") return undefined;
    const normalized = path.posix.normalize(operand);
    const drive = /^\/(cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(normalized);
    if (!drive) return undefined;
    return {
        path: path.win32.resolve(
            `${drive[2].toUpperCase()}:\\`,
            drive[3]?.replaceAll("/", "\\") ?? "",
        ),
        isExact: flavor === (drive[1] ? "cygwin" : "msys"),
    };
}
