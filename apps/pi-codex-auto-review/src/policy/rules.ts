import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { GuardError, immutable } from "../contracts.js";
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
/** Advanced scripts are matched as the real outer shell invocation, never as a safe inner prefix. */
export function ruleCommands(
    command: string,
    shellPath = "/bin/bash",
    depth = 0,
): readonly (readonly string[])[] {
    const parsed = analyzeShell(command);
    if (
        !parsed.isSupported ||
        parsed.commands.some(
            (item) => item.reads.length || item.writes.length,
        ) ||
        depth > 4
    )
        return [[shellPath, "-c", command]];
    return parsed.commands.flatMap((item) => {
        const [program, flag, script] = item.argv;
        if (
            program !== undefined &&
            ["bash", "sh", "zsh", "dash"].includes(basename(program)) &&
            item.argv.length === 3 &&
            flag !== undefined &&
            ["-c", "-lc"].includes(flag) &&
            script !== undefined
        ) {
            const inner = analyzeShell(script);
            if (
                inner.isSupported &&
                inner.commands.every(
                    (part) => !part.reads.length && !part.writes.length,
                )
            )
                return ruleCommands(script, program, depth + 1);
        }
        return [item.argv];
    });
}
