import type { Budget } from "./lexer.js";

/** Rust/Starlark White_Space includes NEL and excludes the JavaScript BOM whitespace. */
export function trimWhitespace(value: string): string {
    return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

export type Value =
    | null
    | boolean
    | bigint
    | number
    | string
    | Value[]
    | Tuple
    | Range
    | StringIterator
    | Dict
    | Callable;
export interface Callable {
    kind: "function";
    name: string;
    call(args: Value[], keywords: Map<string, Value>): Value;
}
export class Tuple {
    constructor(readonly items: Value[]) {}
}
export class Range {
    constructor(
        readonly start: number,
        readonly stop: number,
        readonly step: number,
    ) {}
    get length(): number {
        return Math.max(0, Math.ceil((this.stop - this.start) / this.step));
    }
    items(): Value[] {
        return Array.from({ length: this.length }, (_, index) =>
            BigInt(this.start + index * this.step),
        );
    }
}
export class StringIterator {
    constructor(readonly items: Value[]) {}
}
function hash(value: Value): string {
    if (value === null) return "none";
    if (typeof value === "string") return `s${value.length}:${value}`;
    if (typeof value === "bigint" || typeof value === "number")
        return `n${value}`;
    if (typeof value === "boolean") return `b${value}`;
    if (value instanceof Tuple)
        return `t${value.items
            .map(hash)
            .map((part) => `${part.length}:${part}`)
            .join("")}`;
    throw new Error(`Unhashable ${typeName(value)}`);
}
export class Dict {
    private readonly data = new Map<string, [Value, Value]>();
    get size(): number {
        return this.data.size;
    }
    entries(): [Value, Value][] {
        return [...this.data.values()];
    }
    has(key: Value): boolean {
        return this.data.has(hash(key));
    }
    get(key: Value): Value {
        const entry = this.data.get(hash(key));
        if (!entry) throw new Error(`Missing dictionary key ${repr(key)}`);
        return entry[1];
    }
    set(key: Value, value: Value): void {
        this.data.set(hash(key), [key, value]);
    }
    delete(key: Value): void {
        if (!this.data.delete(hash(key)))
            throw new Error("Missing dictionary key");
    }
    clear(): void {
        this.data.clear();
    }
}
export function typeName(value: Value): string {
    if (value === null) return "NoneType";
    if (Array.isArray(value)) return "list";
    if (value instanceof Tuple) return "tuple";
    if (value instanceof Range) return "range";
    if (value instanceof StringIterator) return "iterator";
    if (value instanceof Dict) return "dict";
    return {
        boolean: "bool",
        bigint: "int",
        number: "float",
        string: "string",
        object: "function",
        function: "function",
        undefined: "NoneType",
        symbol: "unknown",
    }[typeof value];
}
export function truth(value: Value): boolean {
    if (value instanceof Dict) return value.size > 0;
    if (value instanceof Tuple) return value.items.length > 0;
    if (value instanceof Range) return value.length > 0;
    if (Array.isArray(value) || typeof value === "string")
        return value.length > 0;
    return value !== null && value !== false && value !== 0n && value !== 0;
}
export function sequence(value: Value): Value[] {
    if (Array.isArray(value)) return value;
    if (value instanceof Tuple) return value.items;
    if (value instanceof Range) return value.items();
    if (value instanceof StringIterator) return value.items;
    if (value instanceof Dict) return value.entries().map(([key]) => key);
    throw new Error(`${typeName(value)} is not iterable`);
}
export function integer(value: Value): number {
    if (
        typeof value !== "bigint" ||
        value > BigInt(Number.MAX_SAFE_INTEGER) ||
        value < BigInt(Number.MIN_SAFE_INTEGER)
    )
        throw new Error("Expected an integer in the supported range");
    return Number(value);
}
export function text(value: Value): string {
    if (typeof value !== "string")
        throw new Error(`Expected string, got ${typeName(value)}`);
    return value;
}
export function equal(left: Value, right: Value, depth = 0): boolean {
    if (depth > 128)
        throw new Error("Value comparison exceeded its depth budget");
    if (left === right) return true;
    if (
        (typeof left === "bigint" && typeof right === "number") ||
        (typeof left === "number" && typeof right === "bigint")
    )
        return left <= right && left >= right;
    if (left instanceof Range && right instanceof Range)
        return (
            left.length === right.length &&
            (left.length === 0 ||
                (left.start === right.start &&
                    (left.length === 1 || left.step === right.step)))
        );
    if (
        (Array.isArray(left) && Array.isArray(right)) ||
        (left instanceof Tuple && right instanceof Tuple)
    ) {
        const a = sequence(left),
            b = sequence(right);
        return (
            a.length === b.length &&
            a.every((value, index) => equal(value, b[index], depth + 1))
        );
    }
    if (left instanceof Dict && right instanceof Dict)
        return (
            left.size === right.size &&
            left
                .entries()
                .every(
                    ([key, value]) =>
                        right.has(key) &&
                        equal(value, right.get(key), depth + 1),
                )
        );
    return false;
}
export function compare(left: Value, right: Value): number {
    if (
        (typeof left === "bigint" || typeof left === "number") &&
        (typeof right === "bigint" || typeof right === "number")
    )
        return left < right ? -1 : left > right ? 1 : 0;
    if (typeof left === "string" && typeof right === "string")
        return Buffer.compare(Buffer.from(left), Buffer.from(right));
    if (typeof left === "boolean" && typeof right === "boolean")
        return Number(left) - Number(right);
    if (
        (Array.isArray(left) && Array.isArray(right)) ||
        (left instanceof Tuple && right instanceof Tuple)
    ) {
        const a = sequence(left),
            b = sequence(right);
        for (let index = 0; index < Math.min(a.length, b.length); index++)
            if (!equal(a[index], b[index])) return compare(a[index], b[index]);
        return a.length - b.length;
    }
    throw new Error(`Cannot order ${typeName(left)} and ${typeName(right)}`);
}
export function repr(value: Value, depth = 0): string {
    if (depth > 128)
        throw new Error("Value representation exceeded its depth budget");
    if (value === null) return "None";
    if (typeof value === "boolean") return value ? "True" : "False";
    if (typeof value === "string")
        return `"${[...value]
            .map((char) => {
                const point = char.codePointAt(0) ?? 0;
                if (char === '"' || char === "\\") return `\\${char}`;
                if (char === "\n") return "\\n";
                if (char === "\r") return "\\r";
                if (char === "\t") return "\\t";
                if (point < 0x20 || (point >= 0x7f && point <= 0xff))
                    return `\\x${point.toString(16).padStart(2, "0")}`;
                if (point > 0xffff)
                    return `\\U${point.toString(16).padStart(8, "0")}`;
                return char;
            })
            .join("")}"`;
    if (typeof value === "bigint") return String(value);
    if (typeof value === "number")
        return Number.isNaN(value)
            ? "nan"
            : value === Infinity
              ? "+inf"
              : value === -Infinity
                ? "-inf"
                : Number.isInteger(value)
                  ? `${value}.0`
                  : String(value);
    if (value instanceof Range)
        return value.start === 0 && value.step === 1
            ? `range(${value.stop})`
            : `range(${value.start}, ${value.stop}${value.step === 1 ? "" : `, ${value.step}`})`;
    if (value instanceof StringIterator) return "iterator";
    if (Array.isArray(value))
        return `[${value.map((item) => repr(item, depth + 1)).join(", ")}]`;
    if (value instanceof Tuple)
        return `(${value.items.map((item) => repr(item, depth + 1)).join(", ")}${value.items.length === 1 ? "," : ""})`;
    if (value instanceof Dict)
        return `{${value
            .entries()
            .map(
                ([key, item]) =>
                    `${repr(key, depth + 1)}: ${repr(item, depth + 1)}`,
            )
            .join(", ")}}`;
    return `<function ${value.name}>`;
}
export function display(value: Value): string {
    return typeof value === "string" ? value : repr(value);
}
export function contains(container: Value, value: Value): boolean {
    if (typeof container === "string") return container.includes(text(value));
    if (container instanceof Dict) return container.has(value);
    return sequence(container).some((item) => equal(item, value));
}
export function binary(
    op: string,
    left: Value,
    right: Value,
    budget: Budget,
): Value {
    budget.tick();
    if (op === "==") return equal(left, right);
    if (op === "!=") return !equal(left, right);
    if (op === "in" || op === "not in")
        return contains(right, left) === (op === "in");
    if (["<", "<=", ">", ">="].includes(op)) {
        const order = compare(left, right);
        return op === "<"
            ? order < 0
            : op === "<="
              ? order <= 0
              : op === ">"
                ? order > 0
                : order >= 0;
    }
    if (op === "+" && typeof left === "string" && typeof right === "string")
        return budget.string(left + right);
    if (
        op === "+" &&
        ((Array.isArray(left) && Array.isArray(right)) ||
            (left instanceof Tuple && right instanceof Tuple))
    ) {
        const a = sequence(left),
            b = sequence(right);
        budget.size(a.length + b.length);
        return left instanceof Tuple ? new Tuple([...a, ...b]) : [...a, ...b];
    }
    if (op === "*" && (typeof left === "bigint" || typeof right === "bigint")) {
        const value = typeof left === "bigint" ? right : left,
            count = Math.max(
                0,
                integer(typeof left === "bigint" ? left : right),
            );
        if (typeof value === "string") {
            if (count * value.length > 8 * 1024 * 1024)
                throw new Error("Rule string exceeded its size budget");
            return value.repeat(count);
        }
        if (Array.isArray(value) || value instanceof Tuple) {
            const items = sequence(value);
            budget.size(items.length * count);
            const result = Array.from({ length: count }, () => items).flat();
            return value instanceof Tuple ? new Tuple(result) : result;
        }
    }
    if (left instanceof Dict && right instanceof Dict && op === "|") {
        const result = new Dict();
        for (const [key, value] of [...left.entries(), ...right.entries()])
            result.set(key, value);
        budget.size(result.size);
        return result;
    }
    if (typeof left === "bigint" && typeof right === "bigint" && op !== "/") {
        if ((op === "//" || op === "%") && right === 0n)
            throw new Error("Division by zero");
        if (["<<", ">>"].includes(op) && (right < 0n || right > 100000n))
            throw new Error("Invalid shift count");
        let result: bigint;
        switch (op) {
            case "+":
                result = left + right;
                break;
            case "-":
                result = left - right;
                break;
            case "*":
                result = left * right;
                break;
            case "//":
                result =
                    left / right -
                    (left % right !== 0n && left < 0n !== right < 0n ? 1n : 0n);
                break;
            case "%":
                result = ((left % right) + right) % right;
                break;
            case "|":
                result = left | right;
                break;
            case "&":
                result = left & right;
                break;
            case "^":
                result = left ^ right;
                break;
            case "<<":
                result = left << right;
                break;
            case ">>":
                result = left >> right;
                break;
            default:
                throw new Error(`Unsupported operator ${op}`);
        }
        if (result.toString(16).length > 25000)
            throw new Error("Rule integer exceeded its size budget");
        return result;
    }
    if (
        (typeof left === "number" || typeof left === "bigint") &&
        (typeof right === "number" || typeof right === "bigint")
    ) {
        const a = Number(left),
            b = Number(right);
        if (["/", "//", "%"].includes(op) && b === 0)
            throw new Error("Division by zero");
        switch (op) {
            case "+":
                return a + b;
            case "-":
                return a - b;
            case "*":
                return a * b;
            case "/":
                return a / b;
            case "//":
                return Math.floor(a / b);
            case "%":
                return ((a % b) + b) % b;
        }
    }
    throw new Error(`Invalid ${typeName(left)} ${op} ${typeName(right)}`);
}
