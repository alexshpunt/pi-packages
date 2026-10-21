import { commandName } from "./platform-paths.js";
import type { ParsedCommand } from "./shell.js";

/** A path operand; inexact targets come from wildcards or ambiguous mappings. */
export interface ShellTarget {
    readonly operand: string;
    /** False when only protection checks may use the target and the command needs review. */
    readonly isExact: boolean;
    /** No file-system location (a PowerShell provider path): reviewed, never resolved. */
    readonly isUnlocatable?: boolean;
}
/** What a literal command may read, write or contact, over-approximated for writes. */
export interface CommandEffects {
    /** Unknown programs and unsupported parameter forms need review. */
    readonly isKnown: boolean;
    readonly reads: readonly ShellTarget[];
    readonly writes: readonly ShellTarget[];
    /** Non-read-only git subcommands may write repository metadata. */
    readonly writesGitMetadata: boolean;
    readonly network?: {
        readonly urls: readonly string[];
        /** A destination hidden in a config file or proxy still needs review. */
        readonly isIndirect: boolean;
    };
}

const BASH_SAFE_READS = new Set([
    "pwd",
    "echo",
    "printf",
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "rg",
    "grep",
    "find",
    "stat",
    "true",
    "false",
]);
const BASH_OUTPUT_ONLY = new Set(["echo", "printf", "true", "false", "pwd"]);
const BASH_PATH_WRITES = new Set([
    "touch",
    "mkdir",
    "rmdir",
    "rm",
    "truncate",
    "tee",
    "chmod",
    "chown",
]);
const BASH_KNOWN = new Set([
    ...BASH_PATH_WRITES,
    "cp",
    "mv",
    "git",
    "curl",
    "wget",
]);
export const READ_ONLY_GIT_SUBCOMMANDS = new Set([
    "status",
    "diff",
    "log",
    "show",
    "ls-files",
    "rev-parse",
]);

const exact = (operand: string): ShellTarget => ({ operand, isExact: true });

/** curl/wget destinations from a native argument vector. */
export function nativeNetwork(
    executable: string,
    args: readonly string[],
): NonNullable<CommandEffects["network"]> {
    return {
        urls: args.filter((arg) => /^https?:\/\//.test(arg)),
        isIndirect: args.some((arg) =>
            executable === "curl"
                ? /^(?:--config(?:=|$)|-K)/.test(arg)
                : /^(?:--input-file(?:=|$)|-i)/.test(arg),
        ),
    };
}

/** Effects of a bash command; operands only count when the whole script is literal. */
export function bashCommandEffects(
    item: ParsedCommand,
    isSupported: boolean,
    platform: NodeJS.Platform = process.platform,
): CommandEffects {
    const executable = commandName(item.argv[0] ?? "", platform);
    const isSafeRead = BASH_SAFE_READS.has(executable);
    const operands = item.argv.slice(1).filter((arg) => !arg.startsWith("-"));
    const reads = [...item.reads],
        writes = [...item.writes];
    let writesGitMetadata = false,
        network: CommandEffects["network"];
    if (isSupported) {
        if (isSafeRead && !BASH_OUTPUT_ONLY.has(executable))
            reads.push(...operands);
        if (BASH_PATH_WRITES.has(executable)) writes.push(...operands);
        if (executable === "cp" || executable === "mv") {
            reads.push(...operands.slice(0, -1));
            writes.push(...operands.slice(-1));
            if (executable === "mv") writes.push(...operands.slice(0, -1));
        }
        writesGitMetadata =
            executable === "git" &&
            !READ_ONLY_GIT_SUBCOMMANDS.has(item.argv[1] ?? "");
        if (executable === "curl" || executable === "wget")
            network = nativeNetwork(executable, item.argv.slice(1));
    }
    return {
        isKnown: isSafeRead || BASH_KNOWN.has(executable),
        reads: reads.map(exact),
        writes: writes.map(exact),
        writesGitMetadata,
        ...(network ? { network } : {}),
    };
}
