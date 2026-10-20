import type { Budget } from "./lexer.js";
import {
    type Callable,
    compare,
    Dict,
    display,
    equal,
    integer,
    Range,
    repr,
    StringIterator,
    sequence,
    Tuple,
    text,
    trimWhitespace,
    truth,
    typeName,
    type Value,
} from "./values.js";

export function bindArguments(
    name: string,
    args: Value[],
    keywords: Map<string, Value>,
    spec: (string | [string, Value])[],
): Value[] {
    if (args.length > spec.length)
        throw new Error(`${name}: too many arguments`);
    const remaining = new Map(keywords);
    const result = spec.map((parameter, index) => {
        const key = typeof parameter === "string" ? parameter : parameter[0];
        if (index < args.length) {
            if (remaining.has(key))
                throw new Error(`${name}: repeated argument ${key}`);
            return args[index];
        }
        if (remaining.has(key)) {
            const value = remaining.get(key);
            remaining.delete(key);
            return value as Value;
        }
        if (typeof parameter !== "string") return parameter[1];
        throw new Error(`${name}: missing argument ${key}`);
    });
    if (remaining.size)
        throw new Error(
            `${name}: unexpected argument ${remaining.keys().next().value}`,
        );
    return result;
}
function callable(
    name: string,
    spec: (string | [string, Value])[],
    run: (values: Value[]) => Value,
): Callable {
    return {
        kind: "function",
        name,
        call: (args, keywords) =>
            run(bindArguments(name, args, keywords, spec)),
    };
}
function invoke(
    target: Value,
    args: Value[],
    keywords = new Map<string, Value>(),
): Value {
    if (
        !target ||
        typeof target !== "object" ||
        !("kind" in target) ||
        target.kind !== "function"
    )
        throw new Error("Expected a function");
    return target.call(args, keywords);
}
const stringAttributes = [
    "capitalize",
    "codepoints",
    "count",
    "elems",
    "endswith",
    "find",
    "format",
    "index",
    "isalnum",
    "isalpha",
    "isdigit",
    "islower",
    "isspace",
    "istitle",
    "isupper",
    "join",
    "lower",
    "lstrip",
    "partition",
    "removeprefix",
    "removesuffix",
    "replace",
    "rfind",
    "rindex",
    "rpartition",
    "rsplit",
    "rstrip",
    "split",
    "splitlines",
    "startswith",
    "strip",
    "title",
    "upper",
];
function attributes(value: Value): string[] {
    if (typeof value === "string") return stringAttributes;
    if (Array.isArray(value))
        return [
            "append",
            "clear",
            "extend",
            "index",
            "insert",
            "pop",
            "remove",
        ];
    if (value instanceof Dict)
        return [
            "clear",
            "get",
            "items",
            "keys",
            "pop",
            "popitem",
            "setdefault",
            "update",
            "values",
        ];
    return [];
}
export function standardGlobals(
    budget: Budget,
    mutate: (value: Value) => void,
): Map<string, Value> {
    const globals = new Map<string, Value>();
    const add = (
        name: string,
        spec: (string | [string, Value])[],
        run: (values: Value[]) => Value,
    ) => globals.set(name, callable(name, spec, run));
    add("len", ["x"], ([value]) =>
        BigInt(
            typeof value === "string"
                ? [...value].length
                : value instanceof Dict
                  ? value.size
                  : sequence(value).length,
        ),
    );
    add("str", [["x", ""]], ([value]) => budget.string(display(value)));
    add("repr", ["x"], ([value]) => budget.string(repr(value)));
    add("type", ["x"], ([value]) => typeName(value));
    add("bool", [["x", false]], ([value]) => truth(value));
    add("list", [["x", new Tuple([])]], ([value]) => [...sequence(value)]);
    add(
        "tuple",
        [["x", new Tuple([])]],
        ([value]) => new Tuple([...sequence(value)]),
    );
    add(
        "int",
        [
            ["x", 0n],
            ["base", 10n],
        ],
        ([value, base]) => {
            if (typeof value === "bigint") return value;
            if (typeof value === "boolean") return value ? 1n : 0n;
            if (typeof value === "number") {
                if (!Number.isFinite(value)) throw new Error("Invalid integer");
                return BigInt(Math.trunc(value));
            }
            const raw = text(value),
                radix = integer(base);
            if (radix !== 0 && (radix < 2 || radix > 36))
                throw new Error("Invalid integer base");
            let body = raw.toLowerCase(),
                sign = 1n;
            if (/^[+-]/.test(body)) {
                if (body[0] === "-") sign = -1n;
                body = body.slice(1);
            }
            let actual = radix;
            if (actual === 0)
                actual = body.startsWith("0x")
                    ? 16
                    : body.startsWith("0o")
                      ? 8
                      : body.startsWith("0b")
                        ? 2
                        : 10;
            if (
                (actual === 16 && body.startsWith("0x")) ||
                (actual === 8 && body.startsWith("0o")) ||
                (actual === 2 && body.startsWith("0b"))
            )
                body = body.slice(2);
            if (!body) throw new Error("Invalid integer");
            let result = 0n;
            for (const char of body) {
                budget.tick();
                const digit = "0123456789abcdefghijklmnopqrstuvwxyz".indexOf(
                    char,
                );
                if (digit < 0 || digit >= actual)
                    throw new Error("Invalid integer");
                result = result * BigInt(actual) + BigInt(digit);
            }
            return result * sign;
        },
    );
    add("float", [["x", 0n]], ([value]) => {
        if (
            typeof value === "number" ||
            typeof value === "bigint" ||
            typeof value === "boolean"
        )
            return Number(value);
        const raw = text(value).toLowerCase();
        if (/\p{White_Space}/u.test(raw)) throw new Error("Invalid float");
        if (/^[+-]?nan$/.test(raw)) return Number.NaN;
        if (/^\+?inf(?:inity)?$/.test(raw)) return Infinity;
        if (/^-inf(?:inity)?$/.test(raw)) return -Infinity;
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/.test(raw))
            throw new Error("Invalid float");
        return Number(raw);
    });
    add("hash", ["x"], ([value]) => {
        const raw = text(value);
        let hash = 0;
        for (let index = 0; index < raw.length; index++)
            hash = (Math.imul(hash, 31) + raw.charCodeAt(index)) | 0;
        return BigInt(hash);
    });
    add("ord", ["x"], ([value]) => {
        const chars = [...text(value)];
        if (chars.length !== 1) throw new Error("ord expects one character");
        return BigInt(chars[0].codePointAt(0) ?? 0);
    });
    add("chr", ["x"], ([value]) => {
        const point = integer(value);
        if (
            point < 0 ||
            point > 0x10ffff ||
            (point >= 0xd800 && point <= 0xdfff)
        )
            throw new Error("Invalid codepoint");
        return String.fromCodePoint(point);
    });
    add("dir", ["x"], ([value]) => [...attributes(value)]);
    add("hasattr", ["x", "name"], ([value, name]) =>
        attributes(value).includes(text(name)),
    );
    globals.set("getattr", {
        kind: "function",
        name: "getattr",
        call(args, keywords) {
            if (keywords.size || args.length < 2 || args.length > 3)
                throw new Error("getattr expects two or three arguments");
            const name = text(args[1]);
            if (attributes(args[0]).includes(name))
                return attribute(args[0], name, budget, mutate);
            if (args.length === 3) return args[2];
            throw new Error(`Missing attribute ${name}`);
        },
    });
    add("abs", ["x"], ([value]) => {
        if (typeof value === "bigint") return value < 0n ? -value : value;
        if (typeof value === "number") return Math.abs(value);
        throw new Error("Expected number");
    });
    add("all", ["iterable"], ([value]) => sequence(value).every(truth));
    add("any", ["iterable"], ([value]) => sequence(value).some(truth));
    add("enumerate", ["iterable", ["start", 0n]], ([value, start]) =>
        sequence(value).map(
            (item, index) => new Tuple([BigInt(integer(start) + index), item]),
        ),
    );
    add("reversed", ["sequence"], ([value]) => [...sequence(value)].reverse());
    add(
        "sorted",
        ["iterable", ["key", null], ["reverse", false]],
        ([value, key, reverse]) => {
            if (typeof reverse !== "boolean")
                throw new Error("reverse must be bool");
            return sequence(value)
                .map((item) => ({
                    item,
                    key: key === null ? item : invoke(key, [item]),
                }))
                .sort((a, b) => {
                    budget.tick();
                    return compare(a.key, b.key) * (reverse ? -1 : 1);
                })
                .map((entry) => entry.item);
        },
    );
    globals.set("range", {
        kind: "function",
        name: "range",
        call(args, keywords) {
            if (keywords.size || args.length < 1 || args.length > 3)
                throw new Error(
                    "range expects one to three positional integers",
                );
            const [start, stop, step] =
                args.length === 1
                    ? [0, integer(args[0]), 1]
                    : [
                          integer(args[0]),
                          integer(args[1]),
                          args.length === 3 ? integer(args[2]) : 1,
                      ];
            if (step === 0) throw new Error("range step cannot be zero");
            const length = Math.max(0, Math.ceil((stop - start) / step));
            budget.size(length);
            return new Range(start, stop, step);
        },
    });
    globals.set("zip", {
        kind: "function",
        name: "zip",
        call(args, keywords) {
            if (keywords.size)
                throw new Error("zip accepts positional arguments");
            const lists = args.map(sequence);
            const length = lists.length
                ? Math.min(...lists.map((items) => items.length))
                : 0;
            budget.size(length);
            return Array.from(
                { length },
                (_, index) => new Tuple(lists.map((items) => items[index])),
            );
        },
    });
    for (const name of ["min", "max"])
        globals.set(name, {
            kind: "function",
            name,
            call(args, keywords) {
                const key = keywords.get("key") ?? null;
                if ([...keywords.keys()].some((key) => key !== "key"))
                    throw new Error("Unexpected comparison argument");
                const values = args.length === 1 ? sequence(args[0]) : args;
                if (!values.length)
                    throw new Error(`${name} of empty sequence`);
                let chosen = values[0],
                    chosenKey = key === null ? chosen : invoke(key, [chosen]);
                for (const value of values.slice(1)) {
                    budget.tick();
                    const candidate =
                        key === null ? value : invoke(key, [value]);
                    if (
                        compare(candidate, chosenKey) *
                            (name === "min" ? 1 : -1) <
                        0
                    ) {
                        chosen = value;
                        chosenKey = candidate;
                    }
                }
                return chosen;
            },
        });
    globals.set("dict", {
        kind: "function",
        name: "dict",
        call(args, keywords) {
            if (args.length > 1)
                throw new Error("dict takes at most one positional argument");
            const result = new Dict();
            if (args.length)
                for (const entry of args[0] instanceof Dict
                    ? args[0].entries()
                    : sequence(args[0]).map(sequence)) {
                    if (entry.length !== 2)
                        throw new Error("dict entry must have two values");
                    result.set(entry[0], entry[1]);
                }
            for (const [key, value] of keywords) result.set(key, value);
            budget.size(result.size);
            return result;
        },
    });
    globals.set("fail", {
        kind: "function",
        name: "fail",
        call(args) {
            throw new Error(args.map(display).join(" "));
        },
    });
    globals.set("print", {
        kind: "function",
        name: "print",
        call(args, keywords) {
            if ([...keywords.keys()].some((key) => key !== "sep"))
                throw new Error("Unexpected print argument");
            budget.string(
                args.map(display).join(text(keywords.get("sep") ?? " ")),
            );
            return null;
        },
    });
    return globals;
}

export function attribute(
    value: Value,
    name: string,
    budget: Budget,
    mutate: (value: Value) => void,
): Callable {
    const method = (
        spec: (string | [string, Value])[],
        run: (args: Value[]) => Value,
    ) => callable(name, spec, run);
    if (Array.isArray(value)) {
        switch (name) {
            case "append":
                return method(["item"], ([item]) => {
                    mutate(value);
                    budget.size(value.length + 1);
                    value.push(item);
                    return null;
                });
            case "extend":
                return method(["items"], ([items]) => {
                    mutate(value);
                    const extra = sequence(items);
                    budget.size(value.length + extra.length);
                    value.push(...extra);
                    return null;
                });
            case "insert":
                return method(["index", "item"], ([index, item]) => {
                    mutate(value);
                    budget.size(value.length + 1);
                    value.splice(integer(index), 0, item);
                    return null;
                });
            case "pop":
                return method([["index", -1n]], ([index]) => {
                    mutate(value);
                    const at = integer(index),
                        position = at < 0 ? value.length + at : at;
                    if (position < 0 || position >= value.length)
                        throw new Error("pop index out of range");
                    return value.splice(position, 1)[0];
                });
            case "remove":
                return method(["item"], ([item]) => {
                    mutate(value);
                    const index = value.findIndex((existing) =>
                        equal(existing, item),
                    );
                    if (index < 0) throw new Error("Value not in list");
                    value.splice(index, 1);
                    return null;
                });
            case "clear":
                return method([], () => {
                    mutate(value);
                    value.length = 0;
                    return null;
                });
            case "index":
                return method(
                    ["item", ["start", 0n], ["end", BigInt(value.length)]],
                    ([item, start, end]) => {
                        for (
                            let index = Math.max(0, integer(start));
                            index < Math.min(value.length, integer(end));
                            index++
                        )
                            if (equal(value[index], item)) return BigInt(index);
                        throw new Error("Value not in list");
                    },
                );
        }
    }
    if (value instanceof Dict) {
        switch (name) {
            case "get":
                return method(["key", ["default", null]], ([key, fallback]) =>
                    value.has(key) ? value.get(key) : fallback,
                );
            case "keys":
                return method([], () => value.entries().map(([key]) => key));
            case "values":
                return method([], () =>
                    value.entries().map(([, item]) => item),
                );
            case "items":
                return method([], () =>
                    value.entries().map((entry) => new Tuple(entry)),
                );
            case "clear":
                return method([], () => {
                    mutate(value);
                    value.clear();
                    return null;
                });
            case "setdefault":
                return method(["key", ["default", null]], ([key, fallback]) => {
                    mutate(value);
                    if (!value.has(key)) {
                        budget.size(value.size + 1);
                        value.set(key, fallback);
                    }
                    return value.get(key);
                });
            case "pop":
                return {
                    kind: "function",
                    name,
                    call(args, keywords) {
                        if (keywords.size || args.length < 1 || args.length > 2)
                            throw new Error("Invalid dict.pop arguments");
                        mutate(value);
                        if (!value.has(args[0])) {
                            if (args.length === 2) return args[1];
                            throw new Error("Missing dictionary key");
                        }
                        const result = value.get(args[0]);
                        value.delete(args[0]);
                        return result;
                    },
                };
            case "popitem":
                return method([], () => {
                    mutate(value);
                    const first = value.entries()[0];
                    if (!first) throw new Error("Empty dictionary");
                    value.delete(first[0]);
                    return new Tuple(first);
                });
            case "update":
                return {
                    kind: "function",
                    name,
                    call(args, keywords) {
                        mutate(value);
                        if (args.length > 1)
                            throw new Error(
                                "dict.update takes at most one positional argument",
                            );
                        if (args.length)
                            for (const entry of args[0] instanceof Dict
                                ? args[0].entries()
                                : sequence(args[0]).map(sequence)) {
                                if (entry.length !== 2)
                                    throw new Error("Invalid dictionary entry");
                                value.set(entry[0], entry[1]);
                            }
                        for (const [key, item] of keywords)
                            value.set(key, item);
                        budget.size(value.size);
                        return null;
                    },
                };
        }
    }
    if (typeof value === "string") return stringMethod(value, name, budget);
    throw new Error(`${typeName(value)} has no attribute ${name}`);
}

function stringMethod(value: string, name: string, budget: Budget): Callable {
    const method = (
        spec: (string | [string, Value])[],
        run: (args: Value[]) => Value,
    ) => callable(name, spec, run);
    switch (name) {
        case "lower":
            return method([], () => value.toLowerCase());
        case "upper":
            return method([], () => value.toUpperCase());
        case "capitalize":
            return method(
                [],
                () =>
                    value.slice(0, 1).toUpperCase() +
                    value.slice(1).toLowerCase(),
            );
        case "join":
            return method(["elements"], ([items]) =>
                budget.string(sequence(items).map(text).join(value)),
            );
        case "elems":
            return method([], () => new StringIterator([...value]));
        case "codepoints":
            return method(
                [],
                () =>
                    new StringIterator(
                        [...value].map((char) =>
                            BigInt(char.codePointAt(0) ?? 0),
                        ),
                    ),
            );
        case "isalnum":
            return method([], () => /^[\p{L}\p{N}]+$/u.test(value));
        case "isalpha":
            return method([], () => /^\p{L}+$/u.test(value));
        case "isdigit":
            return method([], () => /^\p{Nd}+$/u.test(value));
        case "isspace":
            return method([], () => /^\p{White_Space}+$/u.test(value));
        case "islower":
            return method(
                [],
                () => /\p{Ll}/u.test(value) && !/\p{Lu}|\p{Lt}/u.test(value),
            );
        case "isupper":
            return method(
                [],
                () => /\p{Lu}/u.test(value) && !/\p{Ll}|\p{Lt}/u.test(value),
            );
        case "title":
            return method([], () =>
                value.replace(
                    /\p{L}+/gu,
                    (word) =>
                        word.slice(0, 1).toUpperCase() +
                        word.slice(1).toLowerCase(),
                ),
            );
        case "istitle":
            return method(
                [],
                () =>
                    /\p{L}/u.test(value) &&
                    value ===
                        value.replace(
                            /\p{L}+/gu,
                            (word) =>
                                word.slice(0, 1).toUpperCase() +
                                word.slice(1).toLowerCase(),
                        ),
            );
        case "removeprefix":
            return method(["prefix"], ([prefix]) =>
                value.startsWith(text(prefix))
                    ? value.slice(text(prefix).length)
                    : value,
            );
        case "removesuffix":
            return method(["suffix"], ([suffix]) =>
                text(suffix) && value.endsWith(text(suffix))
                    ? value.slice(0, -text(suffix).length)
                    : value,
            );
        case "partition":
        case "rpartition":
            return method(["sep"], ([separator]) => {
                const sep = text(separator);
                if (!sep) throw new Error("Empty separator");
                const index =
                    name === "partition"
                        ? value.indexOf(sep)
                        : value.lastIndexOf(sep);
                return new Tuple(
                    index < 0
                        ? name === "partition"
                            ? [value, "", ""]
                            : ["", "", value]
                        : [
                              value.slice(0, index),
                              sep,
                              value.slice(index + sep.length),
                          ],
                );
            });
        case "splitlines":
            return method([["keepends", false]], ([keepends]) => {
                if (typeof keepends !== "boolean")
                    throw new Error("keepends must be bool");
                const lines = value.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
                if (lines.at(-1) === "") lines.pop();
                return keepends
                    ? lines
                    : lines.map((line) => line.replace(/(?:\r\n|\r|\n)$/, ""));
            });
        case "strip":
        case "lstrip":
        case "rstrip":
            return method([["chars", null]], ([chars]) => {
                const trim = (char: string) =>
                    chars === null
                        ? /\p{White_Space}/u.test(char)
                        : text(chars).includes(char);
                let start = 0,
                    end = value.length;
                if (name !== "rstrip")
                    while (start < end && trim(value[start])) start++;
                if (name !== "lstrip")
                    while (end > start && trim(value[end - 1])) end--;
                return value.slice(start, end);
            });
        case "startswith":
        case "endswith":
            return method(
                [
                    name === "startswith" ? "prefix" : "suffix",
                    ["start", 0n],
                    ["end", BigInt(value.length)],
                ],
                ([part, start, end]) => {
                    const section = value.slice(integer(start), integer(end)),
                        parts = part instanceof Tuple ? part.items : [part];
                    return parts.some((item) =>
                        name === "startswith"
                            ? section.startsWith(text(item))
                            : section.endsWith(text(item)),
                    );
                },
            );
        case "split":
        case "rsplit":
            return method(
                [
                    ["sep", null],
                    ["maxsplit", -1n],
                ],
                ([separator, maxsplit]) => {
                    const limit = integer(maxsplit),
                        sep = separator === null ? null : text(separator);
                    if (sep === "") throw new Error("Empty separator");
                    if (sep === null && limit >= 0) {
                        const words = [
                            ...value.matchAll(/[^\p{White_Space}]+/gu),
                        ];
                        if (!words.length) return [];
                        if (words.length <= limit + 1)
                            return words.map((match) => match[0]);
                        return name === "split"
                            ? [
                                  ...words
                                      .slice(0, limit)
                                      .map((match) => match[0]),
                                  value.slice(words[limit].index),
                              ]
                            : [
                                  value.slice(
                                      0,
                                      (words[words.length - limit - 1].index ??
                                          0) +
                                          words[words.length - limit - 1][0]
                                              .length,
                                  ),
                                  ...words
                                      .slice(words.length - limit)
                                      .map((match) => match[0]),
                              ];
                    }
                    const parts =
                        sep === null
                            ? trimWhitespace(value)
                                  .split(/\p{White_Space}+/u)
                                  .filter(Boolean)
                            : value.split(sep);
                    budget.size(parts.length);
                    if (limit < 0 || parts.length <= limit + 1) return parts;
                    return name === "split"
                        ? [
                              ...parts.slice(0, limit),
                              parts.slice(limit).join(sep ?? " "),
                          ]
                        : [
                              parts
                                  .slice(0, parts.length - limit)
                                  .join(sep ?? " "),
                              ...parts.slice(parts.length - limit),
                          ];
                },
            );
        case "replace":
            return method(
                ["old", "new", ["count", -1n]],
                ([old, replacement, count]) => {
                    const from = text(old),
                        to = text(replacement),
                        limit = integer(count);
                    let used = 0;
                    if (from === "") {
                        const chars = [...value];
                        return budget.string(
                            chars
                                .map(
                                    (char) =>
                                        (limit < 0 || used++ < limit
                                            ? to
                                            : "") + char,
                                )
                                .join("") +
                                (limit < 0 || used < limit ? to : ""),
                        );
                    }
                    return budget.string(
                        value
                            .split(from)
                            .reduce(
                                (result, part, index) =>
                                    index === 0
                                        ? part
                                        : result +
                                          (limit < 0 || used++ < limit
                                              ? to
                                              : from) +
                                          part,
                                "",
                            ),
                    );
                },
            );
        case "find":
        case "rfind":
        case "index":
        case "rindex":
        case "count":
            return method(
                ["sub", ["start", 0n], ["end", BigInt(value.length)]],
                ([part, start, end]) => {
                    const offset =
                            integer(start) < 0
                                ? Math.max(0, value.length + integer(start))
                                : integer(start),
                        section = value.slice(offset, integer(end)),
                        needle = text(part);
                    if (name === "count")
                        return BigInt(
                            needle === ""
                                ? section.length + 1
                                : section.split(needle).length - 1,
                        );
                    const found = name.startsWith("r")
                        ? section.lastIndexOf(needle)
                        : section.indexOf(needle);
                    if (found < 0 && name.endsWith("index"))
                        throw new Error("Substring not found");
                    return BigInt(found < 0 ? -1 : offset + found);
                },
            );
        case "format":
            return {
                kind: "function",
                name,
                call(args, keywords) {
                    let automatic = 0;
                    return budget.string(
                        value.replace(
                            /\{\{|\}\}|\{([^{}]*)\}/g,
                            (match, field: string) => {
                                if (match === "{{") return "{";
                                if (match === "}}") return "}";
                                const conversion = field.endsWith("!r")
                                    ? "r"
                                    : field.endsWith("!s")
                                      ? "s"
                                      : undefined;
                                const raw = conversion
                                    ? field.slice(0, -2)
                                    : field;
                                const key =
                                    raw === "" ? String(automatic++) : raw;
                                const item = /^\d+$/.test(key)
                                    ? args[Number(key)]
                                    : keywords.get(key);
                                if (item === undefined)
                                    throw new Error(
                                        `Missing format argument ${key}`,
                                    );
                                return conversion === "r"
                                    ? repr(item)
                                    : display(item);
                            },
                        ),
                    );
                },
            };
    }
    throw new Error(`string has no attribute ${name}`);
}

export function percentFormat(
    format: string,
    value: Value,
    budget: Budget,
): string {
    if (/%(?![%srdxXofeEgG])/u.test(format))
        throw new Error("Unsupported Starlark percent format");
    const values = value instanceof Tuple ? value.items : [value];
    let index = 0;
    const output = format.replace(
        /%%|%(?:\(([^)]+)\))?([#0 +-]*)(\d*)(?:\.(\d+))?([srdxXofeEgG])/g,
        (
            match,
            key: string,
            flags: string,
            width: string,
            precision: string,
            kind: string,
        ) => {
            if (match === "%%") return "%";
            const item = key
                ? value instanceof Dict
                    ? value.get(key)
                    : undefined
                : values[index++];
            if (item === undefined) throw new Error("Missing format value");
            let result: string;
            if (kind === "s") result = display(item);
            else if (kind === "r") result = repr(item);
            else if (["d", "x", "X", "o"].includes(kind)) {
                if (typeof item !== "bigint")
                    throw new Error("Expected integer format value");
                result = item.toString(
                    kind === "d" ? 10 : kind === "o" ? 8 : 16,
                );
                if (kind === "X") result = result.toUpperCase();
            } else {
                if (typeof item !== "bigint" && typeof item !== "number")
                    throw new Error("Expected numeric format value");
                const digits = precision ? Number(precision) : 6;
                if (digits > 100) throw new Error("Excessive format precision");
                result =
                    kind.toLowerCase() === "f"
                        ? Number(item).toFixed(digits)
                        : kind.toLowerCase() === "e"
                          ? Number(item).toExponential(digits)
                          : String(item);
            }
            const length = Number(width || 0);
            budget.size(length);
            return flags.includes("-")
                ? result.padEnd(length, " ")
                : result.padStart(length, flags.includes("0") ? "0" : " ");
        },
    );
    if (!(value instanceof Dict) && index !== values.length)
        throw new Error("Unused format values");
    return budget.string(output);
}
