// Port of the Apache-2.0 Codex execpolicy contracts at CODEX_EXECPOLICY_REVISION.
// Attribution and upstream revision are recorded in the repository NOTICE.
import { basename, isAbsolute, normalize, resolve } from "node:path";
import {
    CODEX_EXECPOLICY_REVISION,
    type CompiledRules,
    type PrefixRule,
    type RuleMatch,
    type RuleSource,
} from "./rule-types.js";
import { bindArguments } from "./starlark/builtins.js";
import { Evaluator } from "./starlark/evaluator.js";
import {
    type Callable,
    text,
    trimWhitespace,
    type Value,
} from "./starlark/values.js";

function decision(value: Value, isNetwork = false): PrefixRule["decision"] {
    const name = text(value);
    if (isNetwork && name === "deny") return "forbidden";
    if (name !== "allow" && name !== "prompt" && name !== "forbidden")
        throw new Error(`Invalid rule decision ${name}`);
    return name;
}
function reason(value: Value): string | undefined {
    if (value === null) return undefined;
    const result = text(value);
    if (!trimWhitespace(result))
        throw new Error("justification cannot be empty");
    return result;
}
function list(value: Value): Value[] {
    if (!Array.isArray(value)) throw new Error("Expected a list");
    return value;
}
function executableName(raw: string): string {
    return process.platform === "win32"
        ? raw
              .replace(/[A-Z]/g, (char) => char.toLowerCase())
              .replace(/\.(exe|cmd|bat|com)$/, "")
        : raw;
}
function absolutePath(raw: string): string {
    const path =
        process.platform === "win32"
            ? raw.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "")
            : raw;
    return normalize(resolve(path));
}
function networkHost(raw: string): string {
    let host = trimWhitespace(raw);
    if (!host || host.includes("://") || /[/?#]/.test(host))
        throw new Error("network_rule host must be a hostname or IP literal");
    if (host.startsWith("[")) {
        const end = host.indexOf("]");
        if (end < 0 || !/^(:[0-9]+)?$/.test(host.slice(end + 1)))
            throw new Error("Invalid bracketed network host");
        host = host.slice(1, end);
    } else if ((host.match(/:/g) ?? []).length === 1)
        host = host.replace(/^(.+):[0-9]+$/, "$1");
    host = trimWhitespace(host.replace(/\.+$/, "")).replace(/[A-Z]/g, (char) =>
        char.toLowerCase(),
    );
    if (!host || /[*\p{White_Space}]/u.test(host))
        throw new Error(
            "network_rule host must be a specific host without whitespace",
        );
    return host;
}
function shellWords(source: string): string[] {
    const words: string[] = [];
    let word = "",
        quote = "",
        hasWord = false;
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (!quote && /[ \t\r\n]/.test(char)) {
            if (hasWord) {
                words.push(word);
                word = "";
                hasWord = false;
            }
            continue;
        }
        if (!quote && char === "#" && !hasWord) {
            while (index < source.length && source[index] !== "\n") index++;
            continue;
        }
        if (!quote && (char === "'" || char === '"')) {
            quote = char;
            hasWord = true;
            continue;
        }
        if (char === quote) {
            quote = "";
            continue;
        }
        if (char === "\\" && quote !== "'") {
            if (index + 1 === source.length)
                throw new Error("Invalid shell syntax in example");
            const next = source[++index];
            if (quote === '"' && !["$", "`", '"', "\\", "\n"].includes(next))
                word += "\\";
            if (next !== "\n") {
                word += next;
                hasWord = true;
            }
            continue;
        }
        word += char;
        hasWord = true;
    }
    if (quote) throw new Error("Unclosed shell quote in example");
    if (hasWord) words.push(word);
    if (!words.length) throw new Error("Example cannot be empty");
    return words;
}
function examples(value: Value): string[][] {
    return list(value).map((item) => {
        if (typeof item === "string") return shellWords(item);
        const argv = list(item).map(text);
        if (!argv.length) throw new Error("Example cannot be empty");
        return argv;
    });
}
function matches(
    command: readonly string[],
    rules: readonly PrefixRule[],
    hosts: Map<string, string[]>,
): RuleMatch[] {
    if (!command.length) return [];
    const exact = (argv: readonly string[]) =>
        rules
            .filter(
                (rule) =>
                    rule.pattern.length <= argv.length &&
                    rule.pattern.every((part, index) =>
                        typeof part === "string"
                            ? part === argv[index]
                            : part.includes(argv[index]),
                    ),
            )
            .map((rule) => ({
                decision: rule.decision,
                matchedPrefix: argv.slice(0, rule.pattern.length),
                resolvedProgram: null as string | null,
                justification: rule.justification ?? null,
            }));
    const direct = exact(command);
    if (direct.length) return direct;
    const path = absolutePath(command[0]),
        name = executableName(basename(path)),
        allowed = hosts.get(name);
    if (allowed && !allowed.includes(path)) return [];
    return exact([name, ...command.slice(1)]).map((match) => ({
        ...match,
        resolvedProgram: path,
    }));
}
function sortedRule(rule: PrefixRule): string {
    return JSON.stringify({
        decision: rule.decision,
        ...(rule.justification === undefined
            ? {}
            : { justification: rule.justification }),
        pattern: rule.pattern,
    });
}
export function evaluateRuleSources(
    sources: readonly RuleSource[],
    commands: readonly (readonly string[])[] = [],
): CompiledRules {
    const rules: PrefixRule[] = [],
        hosts = new Map<string, string[]>(),
        networkRules: {
            host: string;
            protocol: string;
            decision: PrefixRule["decision"];
            justification: string | null;
        }[] = [];
    const engine = new Evaluator();
    const builtins = new Map<string, Value>();
    const register = (
        name: string,
        spec: (string | [string, Value])[],
        run: (values: Value[]) => void,
    ) => {
        const fn: Callable = {
            kind: "function",
            name,
            call(args, keywords) {
                engine.budget.tick();
                run(bindArguments(name, args, keywords, spec));
                return null;
            },
        };
        builtins.set(name, fn);
    };
    let pending: { rules: PrefixRule[]; yes: string[][]; no: string[][] }[] =
        [];
    register(
        "prefix_rule",
        [
            "pattern",
            ["decision", "allow"],
            ["match", []],
            ["not_match", []],
            ["justification", null],
        ],
        ([pattern, outcome, yes, no, justification]) => {
            const tokens = list(pattern).map((part) => {
                if (typeof part === "string") return part;
                const alternatives = list(part).map(text);
                if (!alternatives.length)
                    throw new Error("Pattern alternatives cannot be empty");
                return alternatives.length === 1
                    ? alternatives[0]
                    : alternatives;
            });
            if (!tokens.length) throw new Error("Pattern cannot be empty");
            const first = tokens[0],
                why = reason(justification);
            const added = (typeof first === "string" ? [first] : first).map(
                (head) => ({
                    pattern: [head, ...tokens.slice(1)],
                    decision: decision(outcome),
                    ...(why === undefined ? {} : { justification: why }),
                }),
            );
            rules.push(...added);
            engine.budget.size(rules.length);
            pending.push({
                rules: added,
                yes: examples(yes),
                no: examples(no),
            });
        },
    );
    register(
        "network_rule",
        ["host", "protocol", "decision", ["justification", null]],
        ([host, protocol, outcome, justification]) => {
            const name = text(protocol),
                normalized = ["https_connect", "http-connect"].includes(name)
                    ? "https"
                    : name;
            if (
                !["http", "https", "socks5_tcp", "socks5_udp"].includes(
                    normalized,
                )
            )
                throw new Error(`Invalid network protocol ${name}`);
            networkRules.push({
                host: networkHost(text(host)),
                protocol: normalized,
                decision: decision(outcome, true),
                justification: reason(justification) ?? null,
            });
            engine.budget.size(networkRules.length);
        },
    );
    register("host_executable", ["name", "paths"], ([raw, values]) => {
        const name = text(raw);
        if (
            !name ||
            basename(name) !== name ||
            [".", ".."].includes(name) ||
            isAbsolute(name) ||
            (process.platform === "win32" && /[/\\:]/.test(name))
        )
            throw new Error("host_executable requires a bare executable name");
        const paths = list(values).map((value) => {
            const path = text(value);
            if (!isAbsolute(path))
                throw new Error("host_executable paths must be absolute");
            const result = absolutePath(path);
            if (executableName(basename(result)) !== executableName(name))
                throw new Error(
                    "host_executable path basename does not match name",
                );
            return result;
        });
        hosts.set(executableName(name), [...new Set(paths)]);
    });
    for (const source of sources) {
        pending = [];
        try {
            engine.run(source.source, builtins);
            for (const item of pending) {
                for (const example of item.no)
                    if (matches(example, item.rules, hosts).length)
                        throw new Error("not_match example matched its rule");
                for (const example of item.yes)
                    if (!matches(example, item.rules, hosts).length)
                        throw new Error("match example did not match its rule");
            }
        } catch (cause) {
            throw new Error(
                `${source.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
                { cause },
            );
        }
    }
    const allowed: string[] = [],
        denied: string[] = [];
    for (const rule of networkRules) {
        if (rule.decision === "prompt") continue;
        for (const entries of [allowed, denied]) {
            const index = entries.indexOf(rule.host);
            if (index >= 0) entries.splice(index, 1);
        }
        (rule.decision === "allow" ? allowed : denied).push(rule.host);
    }
    const result: CompiledRules = {
        revision: CODEX_EXECPOLICY_REVISION,
        rules: [...rules].sort((a, b) => {
            const left = sortedRule(a),
                right = sortedRule(b);
            return left < right ? -1 : left > right ? 1 : 0;
        }),
        matches: commands.map((command) => {
            engine.budget.tick();
            return matches(command, rules, hosts);
        }),
        allowedDomains: allowed,
        deniedDomains: denied,
        networkRules,
        hostExecutables: Object.fromEntries(hosts),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
        throw new Error("Rule result exceeded its size budget");
    return result;
}
