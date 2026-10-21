// Literal subset lowering ported from the Apache-2.0 OpenAI Codex PowerShell parser
// (codex-rs/shell-command/src/command_safety/powershell_tree_sitter.rs) at revision
// 80b88a700e4300022fe1893ecca9b8376d0c85d9, without tree-sitter: anything outside the
// subset fails closed. Attribution is recorded in the repository NOTICE.
import { GuardError } from "../contracts.js";
import type { ParsedCommand, ShellAnalysis } from "./shell.js";

export interface PowerShellCommand extends ParsedCommand {
    /** Receives the previous command's output, which can bind path parameters. */
    readonly receivesPipeline: boolean;
}
export interface PowerShellAnalysis extends ShellAnalysis {
    readonly commands: readonly PowerShellCommand[];
}

// PowerShell treats these as quote and dash spellings even where they look like text.
const UNICODE_SYNTAX = /[\u2013-\u2015\u2018-\u201E]/;
// Wildcards stay literal for native programs; path parameters handle them in classification.
const REJECTED_BARE = new Set([..."$@(){}[],<"]);
const KEYWORDS = new Set([
    "begin",
    "break",
    "catch",
    "class",
    "clean",
    "configuration",
    "continue",
    "data",
    "define",
    "do",
    "dynamicparam",
    "else",
    "elseif",
    "end",
    "enum",
    "exit",
    "filter",
    "finally",
    "for",
    "foreach",
    "from",
    "function",
    "hidden",
    "if",
    "in",
    "inlinescript",
    "parallel",
    "param",
    "process",
    "return",
    "sequence",
    "static",
    "switch",
    "throw",
    "trap",
    "try",
    "until",
    "using",
    "var",
    "while",
    "workflow",
]);
const ESCAPES: Readonly<Record<string, string>> = {
    "0": "\0",
    a: "\u0007",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
};

/** A bounded literal PowerShell grammar with the same result shape as `analyzeShell()`. */
export function analyzePowerShell(script: string): PowerShellAnalysis {
    if (typeof script !== "string" || !script.trim() || script.includes("\0"))
        throw new GuardError("INVALID_COMMAND", "Invalid PowerShell command");
    if (script.length > 100_000)
        return {
            commands: [],
            isSupported: false,
            reason: "Command too long for literal analysis",
        };
    const commands: PowerShellCommand[] = [];
    let argv: string[] = [],
        writes: string[] = [],
        word = "",
        hasWord = false,
        isQuoted = false,
        isClosedQuote = false,
        redirect = false,
        receivesPipeline = false,
        needsCommand = false;
    let isSupported = true,
        reason: string | undefined;
    const unsupported = (text: string) => {
        isSupported = false;
        reason ??= text;
    };
    if (UNICODE_SYNTAX.test(script))
        unsupported(
            "PowerShell Unicode quote or dash spellings require review",
        );
    const finishWord = () => {
        if (!hasWord) return;
        if (!word) unsupported("Empty PowerShell arguments require review");
        if (!isQuoted) checkBareWord(word, argv.length === 0 && !redirect);
        else if (argv.length === 0 && !redirect)
            unsupported("Quoted command names are PowerShell expressions");
        if (word.startsWith("~"))
            unsupported("PowerShell home-relative paths require review");
        if (redirect) writes.push(word);
        else argv.push(word);
        word = "";
        hasWord = false;
        isQuoted = false;
        isClosedQuote = false;
        redirect = false;
    };
    const checkBareWord = (value: string, isCommandName: boolean) => {
        if (isCommandName) {
            if (!/^(?:[A-Za-z_]|\.{1,2}[\\/]|[\\/])/.test(value))
                unsupported("PowerShell expression statements require review");
            if (KEYWORDS.has(value.toLowerCase()))
                unsupported("PowerShell language keywords require review");
        }
        if (value === "--%")
            unsupported("PowerShell stop-parsing tokens require review");
        if (/^-[^-]/.test(value) && /[:=]/.test(value))
            unsupported("Attached PowerShell parameter values require review");
        // PowerShell converts numeric literals before binding; keep only canonical decimals.
        if (/^[+-]?\.?\d/.test(value) && !/^-?(?:0|[1-9]\d*)$/.test(value))
            unsupported("Non-canonical PowerShell numbers require review");
    };
    const finishCommand = () => {
        finishWord();
        if (redirect) unsupported("Missing redirection target");
        if (argv.length) {
            commands.push({ argv, writes, reads: [], receivesPipeline });
            // A pipeline operator may be followed by a newline before its command.
            needsCommand = false;
            receivesPipeline = false;
        } else if (writes.length)
            unsupported("Redirection without literal command");
        argv = [];
        writes = [];
        redirect = false;
    };
    const startsBareCharacter = () => {
        if (isClosedQuote)
            unsupported("Concatenated PowerShell arguments require review");
    };
    for (let i = 0; i < script.length; i++) {
        const ch = script.charAt(i);
        if (ch === "'") {
            if (hasWord)
                unsupported("Concatenated PowerShell arguments require review");
            hasWord = true;
            isQuoted = true;
            let closed = false;
            for (i++; i < script.length; i++) {
                if (script[i] !== "'") word += script[i];
                else if (script[i + 1] === "'") {
                    word += "'";
                    i++;
                } else {
                    closed = true;
                    break;
                }
            }
            if (!closed) unsupported("Unclosed quote");
            isClosedQuote = true;
            continue;
        }
        if (ch === '"') {
            if (hasWord)
                unsupported("Concatenated PowerShell arguments require review");
            hasWord = true;
            isQuoted = true;
            let closed = false;
            for (i++; i < script.length; i++) {
                const next = script.charAt(i);
                if (next === '"') {
                    closed = true;
                    break;
                }
                if (next === "$")
                    unsupported("PowerShell expansion requires review");
                if (next === "`") {
                    const escaped = script.charAt(++i);
                    if (!escaped || /[\r\n]/.test(escaped))
                        unsupported("Trailing escape");
                    else if (Object.hasOwn(ESCAPES, escaped))
                        word += ESCAPES[escaped];
                    else if (/[A-Za-z0-9]/.test(escaped))
                        unsupported(
                            "Version-dependent PowerShell escapes require review",
                        );
                    else word += escaped;
                    continue;
                }
                word += next;
            }
            if (!closed) unsupported("Unclosed quote");
            isClosedQuote = true;
            continue;
        }
        if (ch === "`") {
            startsBareCharacter();
            const escaped = script.charAt(++i);
            if (!escaped || /[\r\n]/.test(escaped))
                unsupported("PowerShell line continuations require review");
            else if (/[A-Za-z0-9]/.test(escaped))
                unsupported(
                    "Version-dependent PowerShell escapes require review",
                );
            word += escaped;
            hasWord = true;
            continue;
        }
        if (ch === "\r" || ch === "\n" || ch === ";") {
            if (ch === ";" && needsCommand)
                unsupported("Missing command after a pipeline operator");
            finishCommand();
            continue;
        }
        if (ch === " " || ch === "\t") {
            finishWord();
            continue;
        }
        if (/\s/.test(ch) || /[\p{Cc}\p{Cf}]/u.test(ch)) {
            unsupported("Non-ASCII whitespace and control characters");
            finishWord();
            continue;
        }
        if (ch === "|" || ch === "&") {
            const isDouble = script[i + 1] === ch;
            if (ch === "&" && !isDouble)
                unsupported("Call and background operators require review");
            finishWord();
            if (redirect || !argv.length)
                unsupported("Missing command before a pipeline operator");
            finishCommand();
            if (isDouble) i++;
            else receivesPipeline = true;
            needsCommand = true;
            continue;
        }
        if (ch === ">") {
            // `2>` and `*>` select output streams; `>&` merges them.
            if (hasWord && !isQuoted && /^[1-6]$/.test(word)) {
                word = "";
                hasWord = false;
            } else finishWord();
            if (redirect) unsupported("Missing redirection target");
            redirect = true;
            if (script[i + 1] === ">") i++;
            if (script[i + 1] === "&")
                unsupported("Stream redirection requires review");
            continue;
        }
        if (ch === "*" && script[i + 1] === ">" && !hasWord) continue;
        if (ch === "#") unsupported("Comments require review");
        if (REJECTED_BARE.has(ch))
            unsupported("Non-literal PowerShell syntax requires review");
        startsBareCharacter();
        word += ch;
        hasWord = true;
    }
    finishCommand();
    if (needsCommand) unsupported("Missing command after a pipeline operator");
    if (!commands.length) unsupported("No literal command");
    return { commands, isSupported, ...(reason ? { reason } : {}) };
}
