import { attribute, percentFormat, standardGlobals } from "./builtins.js";
import { Budget } from "./lexer.js";
import { type Expr, type Parameter, Parser, type Stmt } from "./parser.js";
import { validate } from "./validation.js";
import {
    binary,
    type Callable,
    Dict,
    display,
    integer,
    Range,
    sequence,
    Tuple,
    truth,
    type Value,
} from "./values.js";

class Scope {
    readonly values = new Map<string, Value>();
    readonly declared = new Set<string>();
    constructor(readonly parent?: Scope) {}
    get(name: string): Value {
        if (this.values.has(name)) return this.values.get(name) as Value;
        if (this.declared.has(name))
            throw new Error(`Variable ${name} referenced before assignment`);
        if (this.parent) return this.parent.get(name);
        throw new Error(`Unknown variable ${name}`);
    }
}
class Flow {
    constructor(
        readonly kind: "return" | "break" | "continue",
        readonly value: Value = null,
    ) {}
}
function declareTarget(target: Expr, names: Set<string>): void {
    if (target.kind === "name") names.add(target.name);
    else if (target.kind === "tuple" || target.kind === "list")
        for (const item of target.items) declareTarget(item, names);
}
function declarations(body: Stmt[], names: Set<string>): void {
    for (const statement of body) {
        if (statement.kind === "assign")
            for (const target of statement.targets)
                declareTarget(target, names);
        if (statement.kind === "def") names.add(statement.name);
        if (statement.kind === "for") {
            declareTarget(statement.target, names);
            declarations(statement.body, names);
        }
        if (statement.kind === "if") {
            for (const branch of statement.branches)
                declarations(branch.body, names);
            declarations(statement.otherwise, names);
        }
    }
}

export class Evaluator {
    readonly budget = new Budget();
    private readonly locked = new Map<Value, number>();
    private readonly active = new Set<Callable>();
    private depth = 0;
    run(source: string, builtins: Map<string, Value>): void {
        const globals = new Scope();
        for (const [name, value] of standardGlobals(this.budget, this.mutate))
            globals.values.set(name, value);
        for (const [name, value] of builtins) globals.values.set(name, value);
        const scope = new Scope(globals),
            body = new Parser(source, this.budget).program();
        validate(body, globals.values.keys(), this.budget);
        declarations(body, scope.declared);
        try {
            this.statements(body, scope);
        } catch (error) {
            if (error instanceof Flow)
                throw new Error(`${error.kind} outside a valid block`);
            throw error;
        }
    }
    private mutate = (value: Value): void => {
        this.budget.tick();
        if (this.locked.has(value))
            throw new Error("Cannot mutate a collection during iteration");
    };
    private iterate(value: Value, callback: (item: Value) => void): void {
        const items = sequence(value);
        this.locked.set(value, (this.locked.get(value) ?? 0) + 1);
        try {
            for (const item of items) {
                this.budget.tick();
                callback(item);
            }
        } finally {
            const remaining = (this.locked.get(value) ?? 1) - 1;
            if (remaining) this.locked.set(value, remaining);
            else this.locked.delete(value);
        }
    }
    private assign(target: Expr, value: Value, scope: Scope): void {
        this.budget.tick();
        if (target.kind === "name") {
            scope.values.set(target.name, value);
            return;
        }
        if (target.kind === "tuple" || target.kind === "list") {
            const items = sequence(value);
            if (items.length !== target.items.length)
                throw new Error("Assignment unpacking length mismatch");
            target.items.forEach((item, index) => {
                this.assign(item, items[index], scope);
            });
            return;
        }
        if (target.kind === "index") {
            const container = this.expression(target.object, scope),
                key = this.expression(target.index, scope);
            this.mutate(container);
            if (container instanceof Dict) {
                container.set(key, value);
                this.budget.size(container.size);
                return;
            }
            if (Array.isArray(container)) {
                container[this.position(key, container.length)] = value;
                return;
            }
        }
        throw new Error("Invalid assignment target");
    }
    private position(index: Value, length: number): number {
        const raw = integer(index),
            position = raw < 0 ? length + raw : raw;
        if (position < 0 || position >= length)
            throw new Error("Index out of range");
        return position;
    }
    private statements(body: Stmt[], scope: Scope): void {
        for (const statement of body) {
            this.budget.tick();
            switch (statement.kind) {
                case "expression":
                    this.expression(statement.value, scope);
                    break;
                case "assign": {
                    const value = this.expression(statement.value, scope);
                    for (const target of statement.targets) {
                        if (statement.op === "=")
                            this.assign(target, value, scope);
                        else {
                            const previous = this.expression(target, scope);
                            if (
                                statement.op === "+=" &&
                                Array.isArray(previous) &&
                                Array.isArray(value)
                            ) {
                                this.mutate(previous);
                                this.budget.size(
                                    previous.length + value.length,
                                );
                                previous.push(...value);
                            } else
                                this.assign(
                                    target,
                                    binary(
                                        statement.op.slice(0, -1),
                                        previous,
                                        value,
                                        this.budget,
                                    ),
                                    scope,
                                );
                        }
                    }
                    break;
                }
                case "def":
                    scope.values.set(
                        statement.name,
                        this.function(
                            statement.name,
                            statement.parameters,
                            statement.body,
                            scope,
                            statement.annotation,
                        ),
                    );
                    break;
                case "return":
                    throw new Flow(
                        "return",
                        statement.value
                            ? this.expression(statement.value, scope)
                            : null,
                    );
                case "break":
                case "continue":
                    throw new Flow(statement.kind);
                case "pass":
                    break;
                case "if": {
                    const branch = statement.branches.find((item) =>
                        truth(this.expression(item.condition, scope)),
                    );
                    this.statements(branch?.body ?? statement.otherwise, scope);
                    break;
                }
                case "for":
                    try {
                        this.iterate(
                            this.expression(statement.iterable, scope),
                            (item) => {
                                this.assign(statement.target, item, scope);
                                try {
                                    this.statements(statement.body, scope);
                                } catch (error) {
                                    if (
                                        !(
                                            error instanceof Flow &&
                                            error.kind === "continue"
                                        )
                                    )
                                        throw error;
                                }
                            },
                        );
                    } catch (error) {
                        if (!(error instanceof Flow && error.kind === "break"))
                            throw error;
                    }
                    break;
            }
        }
    }
    private matchesType(annotation: Expr, value: Value): boolean {
        if (annotation.kind === "literal" && annotation.value === null)
            return value === null;
        if (annotation.kind === "binary" && annotation.op === "|")
            return (
                this.matchesType(annotation.left, value) ||
                this.matchesType(annotation.right, value)
            );
        const name =
            annotation.kind === "name"
                ? annotation.name
                : annotation.kind === "literal" &&
                    typeof annotation.value === "string"
                  ? annotation.value
                  : null;
        if (name) {
            switch (name) {
                case "str":
                case "string":
                    return typeof value === "string";
                case "int":
                    return typeof value === "bigint";
                case "float":
                    return typeof value === "number";
                case "bool":
                    return typeof value === "boolean";
                case "list":
                    return Array.isArray(value);
                case "tuple":
                    return value instanceof Tuple;
                case "dict":
                    return value instanceof Dict;
                case "None":
                    return value === null;
                default:
                    throw new Error(`Unsupported type annotation ${name}`);
            }
        }
        if (annotation.kind === "index" && annotation.object.kind === "name") {
            if (annotation.object.name === "list")
                return (
                    Array.isArray(value) &&
                    value.every((item) =>
                        this.matchesType(annotation.index, item),
                    )
                );
            if (
                annotation.object.name === "dict" &&
                annotation.index.kind === "tuple" &&
                annotation.index.items.length === 2
            ) {
                const [keyType, valueType] = annotation.index.items;
                return (
                    value instanceof Dict &&
                    value
                        .entries()
                        .every(
                            ([key, item]) =>
                                this.matchesType(keyType, key) &&
                                this.matchesType(valueType, item),
                        )
                );
            }
        }
        throw new Error("Unsupported type annotation");
    }
    private function(
        name: string,
        parameters: Parameter[],
        body: Stmt[],
        parent: Scope,
        annotation?: Expr,
    ): Callable {
        const defaults = new Map(
            parameters
                .filter((parameter) => parameter.value)
                .map((parameter) => [
                    parameter.name,
                    this.expression(parameter.value as Expr, parent),
                ]),
        );
        const fn: Callable = {
            kind: "function",
            name,
            call: (args, keywords) => {
                if (this.active.has(fn))
                    throw new Error("Recursive rule functions are not allowed");
                if (this.active.size >= 128)
                    throw new Error("Rule call depth exceeded its budget");
                const scope = new Scope(parent);
                declarations(body, scope.declared);
                let index = 0;
                const remaining = new Map(keywords);
                for (const parameter of parameters) {
                    scope.declared.add(parameter.name);
                    if (parameter.mode === "rest") {
                        scope.values.set(
                            parameter.name,
                            new Tuple(args.slice(index)),
                        );
                        index = args.length;
                        continue;
                    }
                    if (parameter.mode === "keywords") {
                        const value = new Dict();
                        for (const [key, item] of remaining)
                            value.set(key, item);
                        remaining.clear();
                        scope.values.set(parameter.name, value);
                        continue;
                    }
                    if (parameter.mode === "normal" && index < args.length) {
                        if (remaining.has(parameter.name))
                            throw new Error(
                                `Repeated argument ${parameter.name}`,
                            );
                        scope.values.set(parameter.name, args[index++]);
                    } else if (remaining.has(parameter.name)) {
                        scope.values.set(
                            parameter.name,
                            remaining.get(parameter.name) as Value,
                        );
                        remaining.delete(parameter.name);
                    } else if (defaults.has(parameter.name))
                        scope.values.set(
                            parameter.name,
                            defaults.get(parameter.name) as Value,
                        );
                    else throw new Error(`Missing argument ${parameter.name}`);
                }
                if (index !== args.length || remaining.size)
                    throw new Error("Unexpected function arguments");
                for (const parameter of parameters)
                    if (
                        parameter.annotation &&
                        !this.matchesType(
                            parameter.annotation,
                            scope.get(parameter.name),
                        )
                    )
                        throw new Error(`Type mismatch for ${parameter.name}`);
                this.active.add(fn);
                const checked = (value: Value) => {
                    if (annotation && !this.matchesType(annotation, value))
                        throw new Error(`Return type mismatch in ${name}`);
                    return value;
                };
                try {
                    this.statements(body, scope);
                    return checked(null);
                } catch (error) {
                    if (error instanceof Flow && error.kind === "return")
                        return checked(error.value);
                    throw error;
                } finally {
                    this.active.delete(fn);
                }
            },
        };
        return fn;
    }
    private expression(expression: Expr, scope: Scope): Value {
        this.budget.tick();
        if (++this.depth > 256)
            throw new Error("Rule value depth exceeded its budget");
        try {
            return this.evaluate(expression, scope);
        } finally {
            this.depth--;
        }
    }
    private evaluate(expression: Expr, scope: Scope): Value {
        switch (expression.kind) {
            case "literal":
                return expression.value;
            case "name":
                return scope.get(expression.name);
            case "format":
                return this.budget.string(
                    expression.parts
                        .map((part) =>
                            typeof part === "string"
                                ? part
                                : display(this.expression(part, scope)),
                        )
                        .join(""),
                );
            case "list":
            case "tuple": {
                this.budget.size(expression.items.length);
                const items = expression.items.map((item) =>
                    this.expression(item, scope),
                );
                return expression.kind === "list" ? items : new Tuple(items);
            }
            case "dict": {
                const value = new Dict();
                for (const [key, item] of expression.entries)
                    value.set(
                        this.expression(key, scope),
                        this.expression(item, scope),
                    );
                this.budget.size(value.size);
                return value;
            }
            case "unary": {
                const value = this.expression(expression.value, scope);
                if (expression.op === "not") return !truth(value);
                if (expression.op === "~" && typeof value === "bigint")
                    return ~value;
                if (typeof value !== "bigint" && typeof value !== "number")
                    throw new Error("Expected numeric unary operand");
                return expression.op === "-" ? -value : value;
            }
            case "binary": {
                const left = this.expression(expression.left, scope);
                if (expression.op === "and")
                    return truth(left)
                        ? this.expression(expression.right, scope)
                        : left;
                if (expression.op === "or")
                    return truth(left)
                        ? left
                        : this.expression(expression.right, scope);
                const right = this.expression(expression.right, scope);
                return expression.op === "%" && typeof left === "string"
                    ? percentFormat(left, right, this.budget)
                    : binary(expression.op, left, right, this.budget);
            }
            case "compare": {
                let previous = this.expression(expression.first, scope);
                for (const comparison of expression.rest) {
                    const value = this.expression(comparison.value, scope);
                    if (
                        !truth(
                            binary(comparison.op, previous, value, this.budget),
                        )
                    )
                        return false;
                    previous = value;
                }
                return true;
            }
            case "conditional":
                return this.expression(
                    truth(this.expression(expression.condition, scope))
                        ? expression.yes
                        : expression.no,
                    scope,
                );
            case "attribute":
                return attribute(
                    this.expression(expression.object, scope),
                    expression.name,
                    this.budget,
                    this.mutate,
                );
            case "index": {
                const object = this.expression(expression.object, scope),
                    key = this.expression(expression.index, scope);
                if (object instanceof Dict) return object.get(key);
                const items =
                    typeof object === "string" ? [...object] : sequence(object);
                return items[this.position(key, items.length)];
            }
            case "slice": {
                const object = this.expression(expression.object, scope),
                    items =
                        typeof object === "string"
                            ? [...object]
                            : sequence(object),
                    length = items.length;
                const step = expression.step
                    ? integer(this.expression(expression.step, scope))
                    : 1;
                if (step === 0) throw new Error("Slice step cannot be zero");
                const bound = (node: Expr | undefined, fallback: number) => {
                    if (!node) return fallback;
                    const raw = integer(this.expression(node, scope));
                    return Math.min(
                        step < 0 ? length - 1 : length,
                        Math.max(
                            step < 0 ? -1 : 0,
                            raw < 0 ? raw + length : raw,
                        ),
                    );
                };
                const start = bound(
                        expression.start,
                        step < 0 ? length - 1 : 0,
                    ),
                    end = bound(expression.end, step < 0 ? -1 : length),
                    result: Value[] = [];
                for (
                    let index = start;
                    step < 0 ? index > end : index < end;
                    index += step
                ) {
                    this.budget.tick();
                    result.push(items[index]);
                }
                if (object instanceof Range)
                    return new Range(
                        object.start + start * object.step,
                        object.start + end * object.step,
                        object.step * step,
                    );
                return typeof object === "string"
                    ? result.join("")
                    : object instanceof Tuple
                      ? new Tuple(result)
                      : result;
            }
            case "call": {
                const target = this.expression(expression.target, scope);
                if (
                    !target ||
                    typeof target !== "object" ||
                    !("kind" in target) ||
                    target.kind !== "function"
                )
                    throw new Error("Value is not callable");
                const args: Value[] = [],
                    keywords = new Map<string, Value>();
                let hasKeyword = false;
                for (const argument of expression.args) {
                    const value = this.expression(argument.value, scope);
                    if (argument.spread && argument.name === "**") {
                        if (!(value instanceof Dict))
                            throw new Error("Expected dictionary after **");
                        for (const [key, item] of value.entries()) {
                            if (typeof key !== "string" || keywords.has(key))
                                throw new Error("Invalid or repeated keyword");
                            keywords.set(key, item);
                        }
                        hasKeyword = true;
                    } else if (argument.spread) args.push(...sequence(value));
                    else if (argument.name) {
                        if (keywords.has(argument.name))
                            throw new Error(
                                `Repeated argument ${argument.name}`,
                            );
                        keywords.set(argument.name, value);
                        hasKeyword = true;
                    } else {
                        if (hasKeyword)
                            throw new Error(
                                "Positional argument follows keyword argument",
                            );
                        args.push(value);
                    }
                }
                this.budget.size(args.length);
                return target.call(args, keywords);
            }
            case "comprehension": {
                const child = new Scope(scope),
                    result: Value[] | Dict = expression.key ? new Dict() : [];
                for (const clause of expression.clauses)
                    if (clause.kind === "for")
                        declareTarget(clause.target, child.declared);
                const visit = (index: number): void => {
                    this.budget.tick();
                    if (index === expression.clauses.length) {
                        if (result instanceof Dict) {
                            result.set(
                                this.expression(expression.key as Expr, child),
                                this.expression(expression.value, child),
                            );
                            this.budget.size(result.size);
                        } else {
                            this.budget.size(result.length + 1);
                            result.push(
                                this.expression(expression.value, child),
                            );
                        }
                        return;
                    }
                    const clause = expression.clauses[index];
                    if (clause.kind === "if") {
                        if (truth(this.expression(clause.condition, child)))
                            visit(index + 1);
                    } else
                        this.iterate(
                            this.expression(
                                clause.iterable,
                                index === 0 ? scope : child,
                            ),
                            (value) => {
                                this.assign(clause.target, value, child);
                                visit(index + 1);
                            },
                        );
                };
                visit(0);
                return result;
            }
            case "lambda":
                return this.function(
                    "<lambda>",
                    expression.parameters,
                    [{ kind: "return", value: expression.value }],
                    scope,
                );
        }
    }
}
