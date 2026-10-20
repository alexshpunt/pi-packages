import { type Budget, lex, type Token } from "./lexer.js";

export type Expr =
    | { kind: "literal"; value: string | number | bigint | boolean | null }
    | { kind: "name"; name: string }
    | { kind: "format"; parts: (string | Expr)[] }
    | { kind: "list" | "tuple"; items: Expr[] }
    | { kind: "dict"; entries: [Expr, Expr][] }
    | { kind: "unary"; op: string; value: Expr }
    | { kind: "binary"; op: string; left: Expr; right: Expr }
    | { kind: "compare"; first: Expr; rest: { op: string; value: Expr }[] }
    | { kind: "conditional"; condition: Expr; yes: Expr; no: Expr }
    | { kind: "attribute"; object: Expr; name: string }
    | { kind: "index"; object: Expr; index: Expr }
    | { kind: "slice"; object: Expr; start?: Expr; end?: Expr; step?: Expr }
    | {
          kind: "call";
          target: Expr;
          args: { name?: string; spread?: boolean; value: Expr }[];
      }
    | { kind: "comprehension"; value: Expr; key?: Expr; clauses: Clause[] }
    | { kind: "lambda"; parameters: Parameter[]; value: Expr };
export interface Parameter {
    name: string;
    mode: "normal" | "rest" | "keywords" | "keyword";
    value?: Expr;
    annotation?: Expr;
}
export type Clause =
    | { kind: "for"; target: Expr; iterable: Expr }
    | { kind: "if"; condition: Expr };
export type Stmt =
    | { kind: "expression"; value: Expr }
    | { kind: "assign"; targets: Expr[]; value: Expr; op: string }
    | {
          kind: "def";
          name: string;
          parameters: Parameter[];
          body: Stmt[];
          annotation?: Expr;
      }
    | {
          kind: "if";
          branches: { condition: Expr; body: Stmt[] }[];
          otherwise: Stmt[];
      }
    | { kind: "for"; target: Expr; iterable: Expr; body: Stmt[] }
    | { kind: "return"; value?: Expr }
    | { kind: "break" | "continue" | "pass" };

const precedence: Record<string, number> = {
    or: 1,
    and: 2,
    "==": 4,
    "!=": 4,
    "<": 4,
    "<=": 4,
    ">": 4,
    ">=": 4,
    in: 4,
    "not in": 4,
    "|": 5,
    "^": 6,
    "&": 7,
    "<<": 8,
    ">>": 8,
    "+": 9,
    "-": 9,
    "*": 10,
    "/": 10,
    "//": 10,
    "%": 10,
};
const reserved = new Set([
    "and",
    "or",
    "not",
    "in",
    "if",
    "else",
    "elif",
    "for",
    "def",
    "return",
    "break",
    "continue",
    "pass",
    "lambda",
    "True",
    "False",
    "None",
    "load",
    "while",
    "class",
    "try",
    "import",
    "yield",
    "await",
    "async",
    "del",
    "global",
    "nonlocal",
    "raise",
    "assert",
]);

export class Parser {
    private index = 0;
    private depth = 0;
    private readonly tokens: Token[];
    constructor(
        source: string,
        private readonly budget: Budget,
    ) {
        this.tokens = lex(source, budget);
    }
    private peek(): Token {
        return this.tokens[this.index];
    }
    private at(text: string): boolean {
        return this.peek().text === text;
    }
    private take(): Token {
        this.budget.tick();
        return this.tokens[this.index++];
    }
    private eat(text: string): boolean {
        if (!this.at(text)) return false;
        this.take();
        return true;
    }
    private expect(text: string): void {
        if (!this.eat(text)) this.fail(`Expected ${text}`);
    }
    private fail(message: string): never {
        throw new Error(`${message} at line ${this.peek()?.line ?? "end"}`);
    }
    private name(): string {
        if (this.peek().kind !== "name" || reserved.has(this.peek().text))
            this.fail("Expected an identifier");
        return this.take().text;
    }
    program(until: "eof" | "dedent" = "eof"): Stmt[] {
        const result: Stmt[] = [];
        while (this.peek().kind !== until) {
            if (this.peek().kind === "eof") this.fail("Unclosed block");
            if (this.peek().kind === "newline") {
                this.take();
                continue;
            }
            result.push(...this.statement());
        }
        return result;
    }
    private block(): Stmt[] {
        this.expect(":");
        if (this.peek().kind !== "newline") return this.simpleLine();
        this.take();
        if (this.peek().kind !== "indent")
            this.fail("Expected an indented block");
        this.take();
        if (++this.depth > 128)
            this.fail("Rule nesting exceeded its depth budget");
        const body = this.program("dedent");
        this.take();
        this.depth--;
        return body;
    }
    private statement(): Stmt[] {
        if (this.eat("def")) {
            const name = this.name();
            this.expect("(");
            const parameters = this.parameters(")");
            this.expect(")");
            const annotation = this.eat("->") ? this.expression() : undefined;
            return [
                {
                    kind: "def",
                    name,
                    parameters,
                    annotation,
                    body: this.block(),
                },
            ];
        }
        if (this.eat("if")) {
            const branches = [
                { condition: this.expression(), body: this.block() },
            ];
            while (this.eat("elif"))
                branches.push({
                    condition: this.expression(),
                    body: this.block(),
                });
            return [
                {
                    kind: "if",
                    branches,
                    otherwise: this.eat("else") ? this.block() : [],
                },
            ];
        }
        if (this.eat("for")) {
            const target = this.target();
            this.expect("in");
            const iterable = this.tuple();
            return [{ kind: "for", target, iterable, body: this.block() }];
        }
        return this.simpleLine();
    }
    private simpleLine(): Stmt[] {
        const statements: Stmt[] = [];
        do {
            if (this.peek().kind === "newline") break;
            if (this.eat("return"))
                statements.push({
                    kind: "return",
                    value: this.isEnd() ? undefined : this.tuple(),
                });
            else if (["break", "continue", "pass"].includes(this.peek().text)) {
                const kind = this.take().text as "break" | "continue" | "pass";
                statements.push({ kind });
            } else {
                const first = this.tuple();
                if (
                    [
                        "=",
                        "+=",
                        "-=",
                        "*=",
                        "/=",
                        "//=",
                        "%=",
                        "|=",
                        "&=",
                        "^=",
                        "<<=",
                        ">>=",
                    ].includes(this.peek().text)
                ) {
                    const op = this.take().text,
                        targets = [first];
                    const value = this.tuple();
                    if (this.at("="))
                        this.fail(
                            "Chained assignments are not supported in Starlark",
                        );
                    statements.push({ kind: "assign", targets, value, op });
                } else statements.push({ kind: "expression", value: first });
            }
        } while (this.eat(";"));
        if (this.peek().kind !== "newline")
            this.fail("Expected end of statement");
        this.take();
        return statements;
    }
    private isEnd(): boolean {
        return (
            this.peek().kind === "newline" ||
            [";", ")", "]", "}", ":"].includes(this.peek().text)
        );
    }
    private tuple(min = 0): Expr {
        const first = this.expression(min);
        if (!this.eat(",")) return first;
        const items = [first];
        while (!this.isEnd() && !this.at("in")) {
            items.push(this.expression(min));
            if (!this.eat(",")) break;
        }
        return { kind: "tuple", items };
    }
    private target(): Expr {
        return this.tuple(5);
    }
    private parameters(end: string): Parameter[] {
        const parameters: Parameter[] = [];
        let isKeyword = false,
            hasDefault = false;
        while (!this.at(end)) {
            let mode: Parameter["mode"] = isKeyword ? "keyword" : "normal";
            if (this.eat("**")) mode = "keywords";
            else if (this.eat("*")) {
                isKeyword = true;
                mode = "rest";
                if (this.eat(",")) continue;
            }
            const name = this.name();
            if (parameters.some((parameter) => parameter.name === name))
                this.fail("Duplicate parameter");
            const annotation =
                end === ")" && this.eat(":") ? this.expression() : undefined;
            const value = this.eat("=") ? this.expression() : undefined;
            if (mode === "normal" && hasDefault && !value)
                this.fail("Required parameter follows a default");
            if (value && ["rest", "keywords"].includes(mode))
                this.fail("Variadic parameter cannot have a default");
            if (mode === "normal" && value) hasDefault = true;
            parameters.push({ name, mode, value, annotation });
            if (mode === "keywords" && this.eat(",") && !this.at(end))
                this.fail("Parameter follows **kwargs");
            if (mode === "keywords" || !this.eat(",")) break;
        }
        return parameters;
    }
    expression(min = 0): Expr {
        if (++this.depth > 128)
            this.fail("Rule expression exceeded its depth budget");
        let left: Expr,
            hasComparison = false;
        if (this.eat("lambda")) {
            const parameters = this.parameters(":");
            this.expect(":");
            left = { kind: "lambda", parameters, value: this.expression() };
        } else if (["not", "+", "-", "~"].includes(this.peek().text)) {
            const op = this.take().text;
            left = {
                kind: "unary",
                op,
                value: this.expression(op === "not" ? 3 : 11),
            };
        } else left = this.atom();
        while (true) {
            if (this.eat(".")) {
                left = { kind: "attribute", object: left, name: this.name() };
                continue;
            }
            if (this.eat("(")) {
                const args: Extract<Expr, { kind: "call" }>["args"] = [];
                while (!this.at(")")) {
                    if (this.eat("**"))
                        args.push({
                            spread: true,
                            name: "**",
                            value: this.expression(),
                        });
                    else if (this.eat("*"))
                        args.push({ spread: true, value: this.expression() });
                    else if (
                        this.peek().kind === "name" &&
                        this.tokens[this.index + 1]?.text === "="
                    ) {
                        const name = this.name();
                        this.take();
                        args.push({ name, value: this.expression() });
                    } else args.push({ value: this.expression() });
                    if (!this.eat(",")) break;
                }
                this.expect(")");
                left = { kind: "call", target: left, args };
                continue;
            }
            if (this.eat("[")) {
                const start = this.at(":") ? undefined : this.tuple();
                if (this.eat(":")) {
                    const end =
                        this.at("]") || this.at(":")
                            ? undefined
                            : this.expression();
                    const step =
                        this.eat(":") && !this.at("]")
                            ? this.expression()
                            : undefined;
                    this.expect("]");
                    left = { kind: "slice", object: left, start, end, step };
                } else {
                    if (!start) this.fail("Missing index");
                    this.expect("]");
                    left = { kind: "index", object: left, index: start };
                }
                continue;
            }
            let op = this.peek().text;
            if (op === "not" && this.tokens[this.index + 1]?.text === "in")
                op = "not in";
            const level = precedence[op];
            if (level === undefined || level < min) break;
            this.take();
            if (op === "not in") this.take();
            const right = this.expression(level + 1);
            if (level === 4) {
                if (hasComparison)
                    this.fail("Starlark comparisons cannot be chained");
                hasComparison = true;
                left = {
                    kind: "compare",
                    first: left,
                    rest: [{ op, value: right }],
                };
            } else left = { kind: "binary", op, left, right };
        }
        if (min === 0 && this.eat("if")) {
            const condition = this.expression(1);
            this.expect("else");
            left = {
                kind: "conditional",
                condition,
                yes: left,
                no: this.expression(),
            };
        }
        this.depth--;
        return left;
    }
    private clauses(): Clause[] {
        const clauses: Clause[] = [];
        while (true) {
            if (this.eat("for")) {
                const target = this.target();
                this.expect("in");
                clauses.push({
                    kind: "for",
                    target,
                    iterable: this.expression(1),
                });
            } else if (this.eat("if"))
                clauses.push({ kind: "if", condition: this.expression(1) });
            else break;
        }
        return clauses;
    }
    private atom(): Expr {
        const token = this.take();
        if (token.kind === "number") {
            if (/^0[0-9]/.test(token.text))
                this.fail("Leading zero in a decimal literal");
            return {
                kind: "literal",
                value:
                    /[.eE]/.test(token.text) && !/^0[xob]/i.test(token.text)
                        ? Number(token.text)
                        : BigInt(token.text),
            };
        }
        if (token.kind === "string") {
            let value = token.text;
            while (this.peek().kind === "string") value += this.take().text;
            return { kind: "literal", value: this.budget.string(value) };
        }
        if (token.kind === "format") {
            const parts: (string | Expr)[] = [];
            let literal = "";
            for (let index = 0; index < token.text.length; index++) {
                const char = token.text[index];
                if (
                    (char === "{" || char === "}") &&
                    token.text[index + 1] === char
                ) {
                    literal += char;
                    index++;
                } else if (char === "{") {
                    parts.push(literal);
                    literal = "";
                    let end = index + 1,
                        depth = 0,
                        quote = "";
                    for (; end < token.text.length; end++) {
                        const current = token.text[end];
                        if (quote) {
                            if (current === "\\") end++;
                            else if (current === quote) quote = "";
                            continue;
                        }
                        if (current === "'" || current === '"') {
                            quote = current;
                            continue;
                        }
                        if (current === "{") depth++;
                        if (current === "}" && depth-- === 0) break;
                    }
                    if (end < 0) this.fail("Unclosed format expression");
                    if (end >= token.text.length)
                        this.fail("Unclosed format expression");
                    const parser = new Parser(
                        token.text.slice(index + 1, end),
                        this.budget,
                    );
                    parts.push(parser.expression());
                    if (parser.peek().kind !== "newline")
                        this.fail("Invalid format expression");
                    index = end;
                } else if (char === "}") this.fail("Unmatched format brace");
                else literal += char;
            }
            parts.push(literal);
            return { kind: "format", parts };
        }
        if (token.kind === "name") {
            if (["True", "False", "None"].includes(token.text))
                return {
                    kind: "literal",
                    value: token.text === "None" ? null : token.text === "True",
                };
            if (reserved.has(token.text))
                this.fail(`Unsupported Starlark construct ${token.text}`);
            return { kind: "name", name: token.text };
        }
        if (token.text === "(") {
            if (this.eat(")")) return { kind: "tuple", items: [] };
            const value = this.tuple();
            this.expect(")");
            return value;
        }
        if (token.text === "[") {
            if (this.eat("]")) return { kind: "list", items: [] };
            const first = this.expression();
            if (this.at("for")) {
                const clauses = this.clauses();
                this.expect("]");
                return { kind: "comprehension", value: first, clauses };
            }
            const items = [first];
            while (this.eat(",") && !this.at("]"))
                items.push(this.expression());
            this.expect("]");
            return { kind: "list", items };
        }
        if (token.text === "{") {
            if (this.eat("}")) return { kind: "dict", entries: [] };
            const key = this.expression();
            this.expect(":");
            const value = this.expression();
            if (this.at("for")) {
                const clauses = this.clauses();
                this.expect("}");
                return { kind: "comprehension", key, value, clauses };
            }
            const entries: [Expr, Expr][] = [[key, value]];
            while (this.eat(",") && !this.at("}")) {
                const next = this.expression();
                this.expect(":");
                entries.push([next, this.expression()]);
            }
            this.expect("}");
            return { kind: "dict", entries };
        }
        this.fail(`Unexpected token ${token.text}`);
    }
}
