/** A lexer for trusted .rules files. No JavaScript evaluation or host bindings. */
export interface Token {
    kind:
        | "name"
        | "number"
        | "string"
        | "format"
        | "symbol"
        | "newline"
        | "indent"
        | "dedent"
        | "eof";
    text: string;
    line: number;
}

export class Budget {
    private steps = 0;
    private readonly deadline = Date.now() + 10000;
    tick(count = 1): void {
        this.steps += count;
        if (this.steps > 1_000_000 || Date.now() > this.deadline)
            throw new Error("Rule evaluation exceeded its execution budget");
    }
    size(length: number): void {
        if (!Number.isSafeInteger(length) || length < 0 || length > 100_000)
            throw new Error("Rule collection exceeded its size budget");
    }
    string(value: string): string {
        if (value.length > 8 * 1024 * 1024)
            throw new Error("Rule string exceeded its size budget");
        return value;
    }
}

export function lex(source: string, budget: Budget): Token[] {
    const tokens: Token[] = [];
    const indents = [0];
    let index = 0,
        line = 1,
        depth = 0,
        isLineStart = true;
    const emit = (kind: Token["kind"], text = "") => {
        tokens.push({ kind, text, line });
    };
    while (index < source.length) {
        budget.tick();
        if (isLineStart && depth === 0) {
            let width = 0;
            while (source[index] === " ") {
                width++;
                index++;
            }
            if (source[index] === "\t")
                throw new Error(`Tabs are not allowed at line ${line}`);
            if (source[index] && !["\r", "\n", "#"].includes(source[index])) {
                if (width > indents[indents.length - 1]) {
                    indents.push(width);
                    emit("indent");
                }
                while (width < indents[indents.length - 1]) {
                    indents.pop();
                    emit("dedent");
                }
                if (width !== indents[indents.length - 1])
                    throw new Error(`Inconsistent indentation at line ${line}`);
            }
            isLineStart = false;
        }
        const char = source[index];
        if (char === " " || char === "\t" || char === "\r") {
            index++;
            continue;
        }
        if (char === "#") {
            while (index < source.length && source[index] !== "\n") index++;
            continue;
        }
        if (char === "\\") {
            const continuation = /^\\\r?\n/.exec(source.slice(index));
            if (!continuation)
                throw new Error(`Unexpected backslash at line ${line}`);
            index += continuation[0].length;
            line++;
            continue;
        }
        if (char === "\n") {
            if (depth === 0 && tokens.at(-1)?.kind !== "newline")
                emit("newline");
            index++;
            line++;
            isLineStart = true;
            continue;
        }
        const stringStart = /^(r|f|rf|fr)?(['"])/i.exec(source.slice(index));
        if (stringStart) {
            const prefix = (stringStart[1] ?? "").toLowerCase(),
                quote = stringStart[2];
            const isRaw = prefix.includes("r"),
                isFormat = prefix.includes("f");
            index += stringStart[0].length;
            const isTriple = source.slice(index, index + 2) === quote.repeat(2);
            if (isTriple) index += 2;
            const ending = quote.repeat(isTriple ? 3 : 1);
            let text = "",
                isClosed = false;
            while (index < source.length) {
                budget.tick();
                if (source.startsWith(ending, index)) {
                    index += ending.length;
                    isClosed = true;
                    break;
                }
                let next = source[index++];
                if (next === "\n") {
                    if (!isTriple)
                        throw new Error(`Unclosed string at line ${line}`);
                    line++;
                }
                if (next === "\\" && index < source.length) {
                    const escaped = source[index++];
                    if (isRaw) {
                        text += next + escaped;
                        continue;
                    }
                    if (escaped === "\n") {
                        line++;
                        continue;
                    }
                    const escapes: Record<string, string> = {
                        n: "\n",
                        r: "\r",
                        t: "\t",
                        a: "\x07",
                        b: "\b",
                        f: "\f",
                        v: "\v",
                        "\\": "\\",
                        "'": "'",
                        '"': '"',
                    };
                    if (escaped in escapes) next = escapes[escaped];
                    else if (["x", "u", "U"].includes(escaped)) {
                        const length =
                            escaped === "x" ? 2 : escaped === "u" ? 4 : 8;
                        const digits = source.slice(index, index + length);
                        if (
                            !new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)
                        )
                            throw new Error("Invalid string escape");
                        const point = Number.parseInt(digits, 16);
                        if (
                            point > 0x10ffff ||
                            (point >= 0xd800 && point <= 0xdfff)
                        )
                            throw new Error("Invalid Unicode escape");
                        next = String.fromCodePoint(point);
                        index += length;
                    } else if (/[0-7]/.test(escaped)) {
                        const digits =
                            escaped +
                            (/^[0-7]{0,2}/.exec(source.slice(index))?.[0] ??
                                "");
                        next = String.fromCharCode(Number.parseInt(digits, 8));
                        index += digits.length - 1;
                    } else next = `\\${escaped}`;
                }
                text += next;
            }
            if (!isClosed) throw new Error(`Unclosed string at line ${line}`);
            emit(isFormat ? "format" : "string", budget.string(text));
            continue;
        }
        const name = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(index));
        if (name) {
            emit("name", name[0]);
            index += name[0].length;
            continue;
        }
        const number =
            /^(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/.exec(
                source.slice(index),
            );
        if (number) {
            emit("number", number[0]);
            index += number[0].length;
            continue;
        }
        const operator =
            /^(?:\/\/=|<<=|>>=|\*\*=|==|!=|<=|>=|\/\/|<<|>>|\*\*|\+=|-=|\*=|\/=|%=|\|=|&=|\^=|->|[()[\]{},:;.+\-*/%<>=|&^~])/.exec(
                source.slice(index),
            );
        if (!operator)
            throw new Error(
                `Unexpected character ${JSON.stringify(char)} at line ${line}`,
            );
        if ("([{".includes(operator[0])) depth++;
        if (")]}".includes(operator[0])) {
            depth--;
            if (depth < 0) throw new Error("Unbalanced brackets");
        }
        emit("symbol", operator[0]);
        index += operator[0].length;
        isLineStart = false;
    }
    if (depth !== 0) throw new Error("Unbalanced brackets");
    if (tokens.at(-1)?.kind !== "newline") emit("newline");
    while (indents.length > 1) {
        indents.pop();
        emit("dedent");
    }
    emit("eof");
    return tokens;
}
