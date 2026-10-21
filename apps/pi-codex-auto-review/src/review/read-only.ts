import { basename, dirname, resolve } from "node:path";
import type { GuardAction, PolicyDecision } from "../contracts.js";
import { commandName } from "../policy/platform-paths.js";
import { analyzePowerShell } from "../policy/powershell.js";
import {
    bindPowerShellParameters,
    isProviderPath,
    resolvePowerShellCommand,
} from "../policy/powershell-commands.js";
import { analyzeShell } from "../policy/shell.js";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const READ_COMMANDS = new Set([
    "cat",
    "head",
    "tail",
    "wc",
    "rg",
    "grep",
    "find",
    "ls",
    "stat",
    "pwd",
]);
/** POSIX locations only; Windows path-qualified executables are never reused. */
const COMMAND_DIRECTORIES = new Set([
    "/bin",
    "/usr/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
]);
const FIND_MUTATIONS = new Set([
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
]);
const EXECUTION_ENV = /^(?:BASH_ENV$|ENV$|BASH_FUNC_|LD_|DYLD_|GIT_CONFIG)/i;

function hasShellOperators(command: string): boolean {
    let quote = "";
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote === "'") {
            if (ch === "'") quote = "";
        } else if (ch === "\\") {
            i++;
        } else if (ch === '"') {
            quote = quote === '"' ? "" : '"';
        } else if (ch === "'" && !quote) {
            quote = "'";
        } else if (!quote && "|&;<>\n".includes(ch)) {
            return true;
        }
    }
    return false;
}

function hasExcludedOption(
    argv: readonly string[],
    excludedOptions: readonly string[],
): boolean {
    return argv.some((arg) => {
        const option = arg.split("=")[0];
        return (
            option.startsWith("--") &&
            option.length > 2 &&
            excludedOptions.some((excluded) => excluded.startsWith(option))
        );
    });
}

function isReadOnlyGit(argv: readonly string[]): boolean {
    let index = 1;
    while (["--no-pager", "--no-optional-locks"].includes(argv[index] ?? ""))
        index++;
    const subcommand = argv[index];
    if (!subcommand) return false;
    const args = argv.slice(index + 1);
    if (hasExcludedOption(args, ["--output", "--ext-diff", "--textconv"]))
        return false;
    if (["status", "ls-files", "rev-parse"].includes(subcommand)) return true;
    return (
        ["diff", "log", "show"].includes(subcommand) &&
        args.includes("--no-ext-diff") &&
        args.includes("--no-textconv")
    );
}

function isReadOnlyShellCommand(
    command: string,
    cwd: string,
    platform: NodeJS.Platform,
): boolean {
    if (hasShellOperators(command)) return false;
    const analysis = analyzeShell(command);
    if (!analysis.isSupported || analysis.commands.length !== 1) return false;
    const parsed = analysis.commands[0];
    if (parsed.writes.length || parsed.reads.length) return false;
    const executable = parsed.argv[0] ?? "";
    if (
        platform === "win32"
            ? /[\\/:]/.test(executable)
            : executable.includes("/") &&
              !COMMAND_DIRECTORIES.has(dirname(resolve(cwd, executable)))
    )
        return false;
    const name =
        platform === "win32"
            ? commandName(executable, platform)
            : basename(executable);
    if (name === "git") return isReadOnlyGit(parsed.argv);
    if (!READ_COMMANDS.has(name)) return false;
    if (
        name === "find" &&
        parsed.argv.some((arg) => FIND_MUTATIONS.has(arg.split("=")[0]))
    )
        return false;
    if (
        name === "rg" &&
        hasExcludedOption(parsed.argv, ["--pre", "--hostname-bin"])
    )
        return false;
    return true;
}

const POWERSHELL_READS = new Set([
    "get-content",
    "get-childitem",
    "get-item",
    "test-path",
    "resolve-path",
    "get-filehash",
    "select-string",
    "get-location",
]);
const WILDCARD = /[*?[\]]/;

/** The PowerShell counterpart: one literal read command without pipelines or redirection. */
function isReadOnlyPowerShellCommand(command: string): boolean {
    const analysis = analyzePowerShell(command);
    if (!analysis.isSupported || analysis.commands.length !== 1) return false;
    const parsed = analysis.commands[0];
    if (parsed.writes.length || parsed.receivesPipeline) return false;
    const resolved = resolvePowerShellCommand(parsed.argv[0] ?? "");
    const args = parsed.argv.slice(1);
    if (resolved?.kind === "native") {
        if (args.some((arg) => arg.includes('"'))) return false;
        if (resolved.name === "git") return isReadOnlyGit(parsed.argv);
        return (
            resolved.name === "rg" &&
            !hasExcludedOption(parsed.argv, ["--pre", "--hostname-bin"])
        );
    }
    if (resolved?.kind !== "cmdlet" || !POWERSHELL_READS.has(resolved.name))
        return false;
    const binding = bindPowerShellParameters(resolved.spec, args);
    // Wildcards and provider paths can reach locations the literal path does not name.
    return (
        binding !== undefined &&
        [...binding.bound.values()].every(
            (value) => !WILDCARD.test(value) && !isProviderPath(value),
        )
    );
}

/** Reuse only bounded local reads, never pipes, mutations, network or fresh-review requests. */
export function isReadOnlyReview(
    action: GuardAction,
    policy: PolicyDecision,
): boolean {
    if (
        policy.kind !== "ask" ||
        policy.isHardDeny ||
        policy.requiresFreshReview ||
        policy.requiresUserInput ||
        policy.approvalCategory === "rules" ||
        policy.approvalCategory === "mcp_elicitations" ||
        policy.authority?.kind === "reviewed-command" ||
        policy.delta.writePaths.length ||
        policy.delta.domains.length ||
        policy.unboundTargets?.includes("write") ||
        action.args.sandbox_permissions === "require_escalated"
    )
        return false;
    if (READ_TOOLS.has(action.tool)) return true;
    if (
        (action.tool !== "bash" && action.tool !== "powershell") ||
        typeof action.args.command !== "string"
    )
        return false;
    const environment = action.args.environment;
    if (
        (environment &&
            typeof environment === "object" &&
            !Array.isArray(environment) &&
            Object.keys(environment).some((key) => EXECUTION_ENV.test(key))) ||
        (Array.isArray(action.args.redactedEnvironmentVariables) &&
            action.args.redactedEnvironmentVariables.some(
                (name) => typeof name === "string" && EXECUTION_ENV.test(name),
            ))
    )
        return false;
    try {
        return action.tool === "powershell"
            ? isReadOnlyPowerShellCommand(action.args.command)
            : isReadOnlyShellCommand(
                  action.args.command,
                  action.cwd,
                  process.platform,
              );
    } catch {
        return false;
    }
}
