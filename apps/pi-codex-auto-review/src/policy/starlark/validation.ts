import type { Budget } from "./lexer.js";
import type { Expr, Parameter, Stmt } from "./parser.js";

interface Names {
    local: Set<string>;
    parent?: Names;
}
function known(name: string, scope: Names): boolean {
    return (
        scope.local.has(name) ||
        (scope.parent ? known(name, scope.parent) : false)
    );
}
function targetNames(target: Expr, names: Set<string>): void {
    if (target.kind === "name") names.add(target.name);
    else if (target.kind === "tuple" || target.kind === "list")
        for (const item of target.items) targetNames(item, names);
    else if (target.kind !== "index")
        throw new Error("Invalid assignment target");
}
function locals(body: Stmt[], names = new Set<string>()): Set<string> {
    for (const statement of body) {
        if (statement.kind === "def") names.add(statement.name);
        if (statement.kind === "assign")
            for (const target of statement.targets) targetNames(target, names);
        if (statement.kind === "for") {
            targetNames(statement.target, names);
            locals(statement.body, names);
        }
        if (statement.kind === "if") {
            for (const branch of statement.branches) locals(branch.body, names);
            locals(statement.otherwise, names);
        }
    }
    return names;
}
/** Resolve every name and control-flow statement, including unreachable branches. */
export function validate(
    body: Stmt[],
    globals: Iterable<string>,
    budget: Budget,
): void {
    const root: Names = {
        local: locals(body),
        parent: { local: new Set(globals) },
    };
    const parameters = (params: Parameter[], scope: Names): void => {
        for (const parameter of params) {
            if (parameter.value) expression(parameter.value, scope);
            if (parameter.annotation) expression(parameter.annotation, scope);
        }
    };
    const expression = (value: Expr, scope: Names): void => {
        budget.tick();
        switch (value.kind) {
            case "name":
                if (!known(value.name, scope))
                    throw new Error(`Unknown variable ${value.name}`);
                break;
            case "literal":
                break;
            case "format":
                for (const item of value.parts)
                    if (typeof item !== "string") expression(item, scope);
                break;
            case "list":
            case "tuple":
                for (const item of value.items) expression(item, scope);
                break;
            case "dict":
                for (const [key, item] of value.entries) {
                    expression(key, scope);
                    expression(item, scope);
                }
                break;
            case "unary":
                expression(value.value, scope);
                break;
            case "binary":
                expression(value.left, scope);
                expression(value.right, scope);
                break;
            case "compare":
                expression(value.first, scope);
                for (const item of value.rest) expression(item.value, scope);
                break;
            case "conditional":
                expression(value.condition, scope);
                expression(value.yes, scope);
                expression(value.no, scope);
                break;
            case "attribute":
                expression(value.object, scope);
                break;
            case "index":
                expression(value.object, scope);
                expression(value.index, scope);
                break;
            case "slice":
                expression(value.object, scope);
                for (const part of [value.start, value.end, value.step])
                    if (part) expression(part, scope);
                break;
            case "call":
                expression(value.target, scope);
                for (const argument of value.args)
                    expression(argument.value, scope);
                break;
            case "lambda": {
                parameters(value.parameters, scope);
                expression(value.value, {
                    parent: scope,
                    local: new Set(
                        value.parameters.map((parameter) => parameter.name),
                    ),
                });
                break;
            }
            case "comprehension": {
                const child: Names = { parent: scope, local: new Set() };
                for (let index = 0; index < value.clauses.length; index++) {
                    const clause = value.clauses[index];
                    if (clause.kind === "for") {
                        expression(
                            clause.iterable,
                            index === 0 ? scope : child,
                        );
                        targetNames(clause.target, child.local);
                    } else expression(clause.condition, child);
                }
                if (value.key) expression(value.key, child);
                expression(value.value, child);
                break;
            }
        }
    };
    const statements = (
        items: Stmt[],
        scope: Names,
        inFunction: boolean,
        loops: number,
    ): void => {
        for (const statement of items) {
            budget.tick();
            switch (statement.kind) {
                case "expression":
                    expression(statement.value, scope);
                    break;
                case "assign":
                    expression(statement.value, scope);
                    for (const target of statement.targets)
                        expression(target, scope);
                    break;
                case "def": {
                    parameters(statement.parameters, scope);
                    if (statement.annotation)
                        expression(statement.annotation, scope);
                    const names = locals(
                        statement.body,
                        new Set(
                            statement.parameters.map(
                                (parameter) => parameter.name,
                            ),
                        ),
                    );
                    statements(
                        statement.body,
                        { parent: scope, local: names },
                        true,
                        0,
                    );
                    break;
                }
                case "if":
                    for (const branch of statement.branches) {
                        expression(branch.condition, scope);
                        statements(branch.body, scope, inFunction, loops);
                    }
                    statements(statement.otherwise, scope, inFunction, loops);
                    break;
                case "for":
                    expression(statement.iterable, scope);
                    expression(statement.target, scope);
                    statements(statement.body, scope, inFunction, loops + 1);
                    break;
                case "return":
                    if (!inFunction)
                        throw new Error("return outside a function");
                    if (statement.value) expression(statement.value, scope);
                    break;
                case "break":
                case "continue":
                    if (!loops)
                        throw new Error(`${statement.kind} outside a loop`);
                    break;
                case "pass":
                    break;
            }
        }
    };
    statements(body, root, false, 0);
}
