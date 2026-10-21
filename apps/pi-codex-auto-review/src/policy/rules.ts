import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { GuardError, immutable } from "../contracts.js";
import { commandName } from "./platform-paths.js";
import { analyzePowerShell } from "./powershell.js";
import { evaluateRuleSources } from "./rule-engine.js";
import type { CompiledRules, PrefixRule, RuleSource } from "./rule-types.js";
import { analyzeShell } from "./shell.js";

export type {
    CompiledRules,
    PrefixRule,
    RuleMatch,
    RuleSource,
} from "./rule-types.js";
export { CODEX_EXECPOLICY_REVISION } from "./rule-types.js";
export function matchesRule(
    argv: readonly string[],
    rule: PrefixRule,
): boolean {
    return (
        rule.pattern.length <= argv.length &&
        rule.pattern.every((part, index) => {
            const argument = argv[index];
            return typeof part === "string"
                ? part === argument
                : argument !== undefined && part.includes(argument);
        })
    );
}
const MAX_BYTES = 8 * 1024 * 1024;
function isScalarString(value: unknown): value is string {
    if (typeof value !== "string") return false;
    for (const char of value) {
        const point = char.codePointAt(0) ?? 0;
        if (point >= 0xd800 && point <= 0xdfff) return false;
    }
    return true;
}
function request(
    sources: readonly RuleSource[],
    commands: readonly (readonly string[])[],
): string {
    const input = JSON.stringify({ sources, commands });
    if (Buffer.byteLength(input) > MAX_BYTES)
        throw new GuardError(
            "INVALID_RULES",
            "Rule request exceeds the supported size",
        );
    const data = JSON.parse(input) as { sources: unknown; commands: unknown };
    if (
        !Array.isArray(data.sources) ||
        !Array.isArray(data.commands) ||
        data.sources.some(
            (source) =>
                source === null ||
                typeof source !== "object" ||
                !isScalarString(source.name) ||
                !isScalarString(source.source) ||
                Object.keys(source).some(
                    (key) => key !== "name" && key !== "source",
                ),
        ) ||
        data.commands.some(
            (command) =>
                !Array.isArray(command) ||
                command.some((argument) => !isScalarString(argument)),
        )
    ) {
        throw new GuardError("INVALID_RULES", "Invalid rule request schema");
    }
    return input;
}
/** Preserve the synchronous API and its deadline without running rules on the host event loop. */
export function parseRules(source: string): readonly PrefixRule[] {
    const sources = [{ name: "inline.rules", source }];
    const input = request(sources, []);
    try {
        const result = spawnSync(
            process.execPath,
            [
                "--max-old-space-size=64",
                fileURLToPath(new URL("./rules-sync.js", import.meta.url)),
            ],
            {
                input,
                encoding: "utf8",
                timeout: 10000,
                killSignal: "SIGKILL",
                maxBuffer: MAX_BYTES,
                env:
                    process.platform === "win32"
                        ? { SystemRoot: process.env.SystemRoot }
                        : {},
            },
        );
        if (result.error || result.status !== 0)
            throw (
                result.error ??
                new Error(
                    result.stderr.slice(0, 4000) ||
                        "Rule process exited without a result",
                )
            );
        return immutable((JSON.parse(result.stdout) as CompiledRules).rules);
    } catch (error) {
        throw new GuardError(
            "INVALID_RULES",
            `Codex-compatible rule engine failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    }
}
export async function evaluateRules(
    sources: readonly RuleSource[],
    commands: readonly (readonly string[])[] = [],
    signal?: AbortSignal,
): Promise<CompiledRules> {
    const data = JSON.parse(request(sources, commands)) as {
        sources: RuleSource[];
        commands: string[][];
    };
    try {
        signal?.throwIfAborted();
        if (!data.sources.length)
            return immutable(evaluateRuleSources([], data.commands));
        const result = await new Promise<CompiledRules>((resolve, reject) => {
            const worker = new Worker(
                new URL("./rules-worker.js", import.meta.url),
                {
                    workerData: data,
                    execArgv: [],
                    env:
                        process.platform === "win32"
                            ? { SystemRoot: process.env.SystemRoot }
                            : {},
                    resourceLimits: {
                        maxOldGenerationSizeMb: 64,
                        stackSizeMb: 4,
                    },
                },
            );
            let isSettled = false;
            const finish = (error?: Error, value?: CompiledRules) => {
                if (isSettled) return;
                isSettled = true;
                clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                worker.removeAllListeners();
                void worker.terminate();
                if (error) reject(error);
                else if (value) resolve(value);
                else reject(new Error("Rule worker produced no result"));
            };
            const abort = () =>
                finish(
                    new Error("Rule evaluation cancelled", {
                        cause: signal?.reason,
                    }),
                );
            const timer = setTimeout(
                () => finish(new Error("Rule evaluation timed out")),
                10000,
            );
            worker.once(
                "message",
                (message: { result?: CompiledRules; error?: string }) =>
                    finish(
                        message.error ? new Error(message.error) : undefined,
                        message.result,
                    ),
            );
            // @types/node 26 types worker errors as unknown; the value is still rejected unchanged.
            worker.once("error", (error) => finish(error as Error));
            worker.once("exit", (code) =>
                finish(
                    new Error(`Rule worker exited without a result (${code})`),
                ),
            );
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
        });
        return immutable(result);
    } catch (error) {
        throw new GuardError(
            "INVALID_RULES",
            "Codex-compatible rule engine could not evaluate the trusted rules",
            { cause: error },
        );
    }
}
/** Evidence identity when a caller supplies no shell; Windows has no fixed `/bin/bash`. */
export function defaultShellIdentity(
    tool: string,
    platform: NodeJS.Platform = process.platform,
): string {
    if (tool === "powershell" || platform === "win32")
        return "pi-default-shell-unresolved";
    return "/bin/bash";
}
const MAX_WRAPPER_DEPTH = 4;
const BASH_WRAPPERS = new Set(["bash", "sh", "zsh", "dash"]);
const POWERSHELL_WRAPPERS = new Set(["powershell", "pwsh"]);
/** Codex `extract_powershell_command` flags; the script must be the final argument. */
const POWERSHELL_FLAGS = new Set(["-nologo", "-noprofile", "-command", "-c"]);

function nestedBashScript(
    argv: readonly string[],
    platform: NodeJS.Platform,
): string | undefined {
    const [program, flag, script] = argv;
    return program !== undefined &&
        BASH_WRAPPERS.has(commandName(program, platform)) &&
        argv.length === 3 &&
        flag !== undefined &&
        ["-c", "-lc"].includes(flag)
        ? script
        : undefined;
}
function nestedPowerShellScript(
    argv: readonly string[],
    platform: NodeJS.Platform,
): string | undefined {
    if (
        argv.length < 3 ||
        !POWERSHELL_WRAPPERS.has(commandName(argv[0] ?? "", platform))
    )
        return undefined;
    const flags = argv.slice(1, -1).map((flag) => flag.toLowerCase());
    const command = flags.at(-1);
    return flags.every((flag) => POWERSHELL_FLAGS.has(flag)) &&
        (command === "-command" || command === "-c") &&
        flags.indexOf(command) === flags.length - 1
        ? argv.at(-1)
        : undefined;
}
/** Advanced scripts are matched as the real outer shell invocation, never as a safe inner prefix. */
export function ruleCommands(
    command: string,
    shellPath = defaultShellIdentity("bash"),
    depth = 0,
    platform: NodeJS.Platform = process.platform,
): readonly (readonly string[])[] {
    const parsed = analyzeShell(command);
    if (
        !parsed.isSupported ||
        parsed.commands.some(
            (item) => item.reads.length || item.writes.length,
        ) ||
        depth > MAX_WRAPPER_DEPTH
    )
        return [[shellPath, "-c", command]];
    return parsed.commands.flatMap((item) => {
        const script = nestedBashScript(item.argv, platform);
        if (script !== undefined) {
            const inner = analyzeShell(script);
            if (
                inner.isSupported &&
                inner.commands.every(
                    (part) => !part.reads.length && !part.writes.length,
                )
            )
                return ruleCommands(script, item.argv[0], depth + 1, platform);
        }
        return [item.argv];
    });
}
/** A rule group and whether it is a command lowered from PowerShell syntax. */
export interface RuleGroup {
    readonly argv: readonly string[];
    /** False for outer invocations and commands unwrapped from bash-family scripts. */
    readonly isPowerShellCommand: boolean;
}
/**
 * Codex PR #20336: a literal PowerShell script matches its inner commands; anything
 * else matches the outer `[shell, "-Command", script]` invocation.
 */
export function powershellRuleGroups(
    script: string,
    shellPath = defaultShellIdentity("powershell"),
    depth = 0,
    platform: NodeJS.Platform = process.platform,
): readonly RuleGroup[] {
    const parsed = analyzePowerShell(script);
    if (
        !parsed.isSupported ||
        parsed.commands.some((item) => item.writes.length) ||
        depth > MAX_WRAPPER_DEPTH
    )
        return [
            {
                argv: [shellPath, "-Command", script],
                isPowerShellCommand: false,
            },
        ];
    return parsed.commands.flatMap((item): readonly RuleGroup[] => {
        const powershell = nestedPowerShellScript(item.argv, platform);
        if (powershell !== undefined) {
            const inner = analyzePowerShell(powershell);
            if (
                inner.isSupported &&
                inner.commands.every((part) => !part.writes.length)
            )
                return powershellRuleGroups(
                    powershell,
                    item.argv[0],
                    depth + 1,
                    platform,
                );
        }
        const bash = nestedBashScript(item.argv, platform);
        if (bash !== undefined) {
            const inner = analyzeShell(bash);
            if (
                inner.isSupported &&
                inner.commands.every(
                    (part) => !part.reads.length && !part.writes.length,
                )
            )
                return ruleCommands(
                    bash,
                    item.argv[0],
                    depth + 1,
                    platform,
                ).map((argv) => ({ argv, isPowerShellCommand: false }));
        }
        return [{ argv: item.argv, isPowerShellCommand: true }];
    });
}
export function powershellRuleCommands(
    script: string,
    shellPath = defaultShellIdentity("powershell"),
    depth = 0,
    platform: NodeJS.Platform = process.platform,
): readonly (readonly string[])[] {
    return powershellRuleGroups(script, shellPath, depth, platform).map(
        (group) => group.argv,
    );
}
