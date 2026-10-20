import { GuardError } from "../contracts.js";

export interface ParsedCommand {
    readonly argv: readonly string[];
    readonly writes: readonly string[];
    readonly reads: readonly string[];
}
export interface ShellAnalysis {
    readonly commands: readonly ParsedCommand[];
    readonly isSupported: boolean;
    readonly reason?: string;
}
/** A bounded literal grammar. Expansion/interpreters cannot borrow permission from their first word. */
export function analyzeShell(command: string): ShellAnalysis {
    if (
        typeof command !== "string" ||
        !command.trim() ||
        command.includes("\0")
    )
        throw new GuardError("INVALID_COMMAND", "Invalid shell command");
    if (command.length > 100_000)
        return {
            commands: [],
            isSupported: false,
            reason: "Command too long for literal analysis",
        };
    const commands: ParsedCommand[] = [];
    let argv: string[] = [],
        writes: string[] = [],
        reads: string[] = [],
        word = "",
        hasWord = false,
        quote = "",
        redirect = "";
    let isSupported = true,
        reason: string | undefined;
    const unsupported = (text: string) => {
        isSupported = false;
        reason ??= text;
    };
    const finishWord = () => {
        if (!hasWord) return;
        if (redirect === ">") writes.push(word);
        else if (redirect === "<") reads.push(word);
        else argv.push(word);
        word = "";
        hasWord = false;
        redirect = "";
    };
    const finishCommand = () => {
        finishWord();
        if (redirect) unsupported("Missing redirection target");
        if (argv.length) commands.push({ argv, writes, reads });
        else if (writes.length || reads.length)
            unsupported("Redirection without literal command");
        argv = [];
        writes = [];
        reads = [];
        redirect = "";
    };
    for (let i = 0; i < command.length; i++) {
        const ch = command.charAt(i);
        if (quote === "'") {
            if (ch === "'") quote = "";
            else word += ch;
            continue;
        }
        if (ch === "\\" && quote !== "'") {
            if (i + 1 >= command.length) unsupported("Trailing escape");
            else {
                word += command[++i];
                hasWord = true;
            }
            continue;
        }
        if (ch === '"') {
            quote = quote === '"' ? "" : '"';
            hasWord = true;
            continue;
        }
        if (ch === "'" && !quote) {
            quote = "'";
            hasWord = true;
            continue;
        }
        if (ch === "$" || ch === "`")
            unsupported("Shell expansion requires review");
        if (quote) {
            word += ch;
            continue;
        }
        if ("(){}*?~".includes(ch))
            unsupported("Non-literal shell syntax requires review");
        if (ch === "#" && !hasWord) {
            unsupported("Comments require review");
            break;
        }
        if (/\s/.test(ch) && ch !== "\n") {
            finishWord();
            continue;
        }
        if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
            finishCommand();
            if (command[i + 1] === ch && "|&".includes(ch)) i++;
            else if (ch === "&")
                unsupported("Background execution requires review");
            continue;
        }
        if (ch === ">" || ch === "<") {
            if (hasWord && /^\d+$/.test(word)) {
                word = "";
                hasWord = false;
            }
            finishWord();
            redirect = ch;
            if (command[i + 1] === ch) {
                i++;
                if (ch === "<") unsupported("Here-documents require review");
            }
            if (command[i + 1] === "&")
                unsupported("Descriptor redirection requires review");
            continue;
        }
        word += ch;
        hasWord = true;
    }
    if (quote) unsupported("Unclosed quote");
    finishCommand();
    if (!commands.length) unsupported("No literal command");
    if (commands.some((c) => c.argv.some((a) => /^\w+=/.test(a))))
        unsupported("Environment assignments require review");
    return { commands, isSupported, ...(reason ? { reason } : {}) };
}
export function matchesPrefix(
    argv: readonly string[],
    prefix: readonly string[],
): boolean {
    return (
        prefix.length > 0 &&
        prefix.length <= argv.length &&
        prefix.every((arg, i) => argv[i] === arg)
    );
}
export const INTERPRETERS = new Set([
    "bash",
    "sh",
    "zsh",
    "fish",
    "dash",
    "node",
    "python",
    "python3",
    "perl",
    "ruby",
    "env",
    "eval",
    "source",
    "exec",
    "xargs",
    "sudo",
    "osascript",
]);
