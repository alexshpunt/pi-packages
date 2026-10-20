// JavaScript side of the differential. The engine variant builds patterns from
// packages/redact/dist exactly as compilePiiRule and createRedactor do; the
// naive variant feeds Rust syntax to RegExp unchanged and must disagree with Rust.
import { closeSync, openSync, writeSync } from "node:fs";

const distUrl = new URL("../../dist/", import.meta.url);
const fromHex = (text) => Buffer.from(text, "hex").toString("utf8");

// The source's built-in rules (redact/rules.rs) as written, for the naive variant.
const RUST_RULE_SOURCES = [
    ["token.aws-access-key", String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`],
    [
        "token.github",
        String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b`,
    ],
    ["token.openai", String.raw`\bsk-[A-Za-z0-9_-]{16,}`],
    ["token.google", String.raw`\bAIza[A-Za-z0-9_-]{30,}`],
    ["token.slack", String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}`],
    [
        "token.jwt",
        String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`,
    ],
    ["token.stripe", String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`],
    ["token.gitlab", String.raw`\bglpat-[A-Za-z0-9_-]{20,}`],
    ["token.npm", String.raw`\bnpm_[A-Za-z0-9]{20,}`],
    [
        "token.sendgrid",
        String.raw`\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}`,
    ],
    [
        "credential.authorization",
        String.raw`(?i)\b(?:authorization|proxy[-_]authorization)["']?[ \t]*[:=][ \t]*["']?(?:Bearer|Basic)[ \t]+(?P<secret>[A-Za-z0-9_~+/=.-]+)`,
    ],
    [
        "credential.bearer",
        String.raw`\bBearer[ \t]+(?P<secret>[A-Za-z0-9_~+/=.-]{8,})`,
    ],
    [
        "credential.url-password",
        String.raw`(?i)\b[a-z][a-z0-9+.-]*://[^\s/:@]+:(?P<secret>[^\s/@]+)@`,
    ],
    [
        "credential.webhook-url",
        String.raw`(?i)\bhttps?://[^\s/"'${"`"}<>]+/(?:[^\s?\#"'${"`"}<>]*/)?hooks/(?P<secret>[A-Za-z0-9_-]{16,}(?:[/?\#][^\s"'${"`"}<>]*)?)`,
    ],
];

const naiveTranslate = (pattern) =>
    pattern
        .replaceAll("(?P<", "(?<")
        .replaceAll("(?i)", "")
        .replaceAll("\\z", "(?![\\s\\S])")
        .replaceAll("\\#", "#");

function encodeRuns(tokens) {
    const parts = [];
    for (let index = 0; index < tokens.length; ) {
        let end = index + 1;
        while (end < tokens.length && tokens[end] === tokens[index]) end++;
        parts.push(
            end - index > 1 ? `${tokens[index]}*${end - index}` : tokens[index],
        );
        index = end;
    }
    return parts.join(",");
}

/** UTF-16 index -> UTF-8 byte offset, and every code-point start plus the end. */
function measure(text) {
    const utf8Offsets = new Array(text.length + 1);
    const starts = [];
    let byteOffset = 0;
    for (let index = 0; index < text.length; ) {
        const code = text.codePointAt(index) ?? 0;
        const width = code > 0xffff ? 2 : 1;
        starts.push(index);
        utf8Offsets[index] = byteOffset;
        if (width === 2) utf8Offsets[index + 1] = byteOffset;
        byteOffset +=
            code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        index += width;
    }
    utf8Offsets[text.length] = byteOffset;
    starts.push(text.length);
    return { utf8Offsets, starts };
}

function createLineWriter(path) {
    const descriptor = openSync(path, "w");
    let buffer = "";
    return {
        write(line) {
            buffer += `${line}\n`;
            if (buffer.length > 1 << 20) {
                writeSync(descriptor, buffer);
                buffer = "";
            }
        },
        close() {
            writeSync(descriptor, buffer);
            closeSync(descriptor);
        },
    };
}

export async function loadEngine() {
    const load = (path) => import(new URL(path, distUrl).href);
    const [regex, accelerators, rules, text] = await Promise.all([
        load("pii/regex.js"),
        load("pii/accelerators.js"),
        load("rules.js"),
        load("text.js"),
    ]);
    return {
        translateRustRegex: regex.translateRustRegex,
        createCandidateSearch: accelerators.createCandidateSearch,
        builtInRules: rules.BUILT_IN_RULES,
        detectPrivateKeys: rules.detectPrivateKeys,
        hasSensitiveSuffix: rules.hasSensitiveSuffix,
        normalizeFieldName: rules.normalizeFieldName,
        detectAssignments: text.detectAssignments,
    };
}

/** Returns a pattern compiler and the core rules for the engine or naive variant. */
function createVariant(engine, isNaive) {
    let compileErrorCount = 0;
    const build = (source, flags) => {
        try {
            return new RegExp(source, flags);
        } catch {
            compileErrorCount++;
            return /(?!)/;
        }
    };
    const regexSearch = (search) => (text) => (cursor) => {
        search.lastIndex = cursor;
        return search.exec(text)?.index;
    };
    function compilePattern(line) {
        const [entity, caseFlag, expressionHex, leftBoundaryHex, fieldFlag] =
            line.split("\t");
        const isCaseInsensitive = caseFlag === "1";
        const expression = fromHex(expressionHex);
        const leftBoundary = fromHex(leftBoundaryHex);
        const hasLeftBoundary = fieldFlag !== "1" && leftBoundary !== "";
        const flags = `u${isCaseInsensitive ? "i" : ""}s`;
        if (isNaive)
            return {
                entity,
                search: regexSearch(
                    build(
                        naiveTranslate(expression.replaceAll("\\b", "")),
                        `${flags}mg`,
                    ),
                ),
                anchored: build(
                    `(?<pii_candidate>${naiveTranslate(expression)})`,
                    `${flags}myd`,
                ),
                leftBoundary: hasLeftBoundary
                    ? build(`^(?:${naiveTranslate(leftBoundary)})$`, flags)
                    : undefined,
            };
        // Mirrors compilePiiRule in src/pii/patterns.ts.
        const translate = (pattern) =>
            engine.translateRustRegex(pattern, isCaseInsensitive);
        return {
            entity,
            search:
                engine.createCandidateSearch(expression) ??
                regexSearch(
                    new RegExp(
                        translate(expression.replaceAll("\\b", "")),
                        `${flags}g`,
                    ),
                ),
            anchored: new RegExp(
                `(?<pii_candidate>${translate(expression)})`,
                `${flags}yd`,
            ),
            leftBoundary: hasLeftBoundary
                ? new RegExp(`^(?:${translate(leftBoundary)})$`, flags)
                : undefined,
        };
    }
    const coreRules = isNaive
        ? RUST_RULE_SOURCES.map(([id, source]) => {
              const pattern = build(
                  naiveTranslate(source),
                  `${source.startsWith("(?i)") ? "i" : ""}ugd`,
              );
              return {
                  id,
                  *match(text) {
                      for (const found of text.matchAll(pattern)) {
                          const whole = found.indices?.[0] ?? [0, 0];
                          const secret = found.indices?.groups?.secret;
                          const [start, end] =
                              secret && secret[0] < secret[1] ? secret : whole;
                          if (start < end) yield [start, end];
                      }
                  },
              };
          })
        : engine.builtInRules;
    return {
        compilePattern,
        coreRules,
        compileErrorCount: () => compileErrorCount,
    };
}

/**
 * Same lines as `redact-rust-differential pii`: for every pattern selected by the
 * input's entity tag, the search start from every cursor, the anchored candidate
 * at every start, and the left-boundary result for every preceding character.
 */
export function writePiiResults(
    engine,
    { patternLines, inputLines, outputPath, isNaive = false },
) {
    const variant = createVariant(engine, isNaive);
    const patterns = patternLines.map(variant.compilePattern);
    const writer = createLineWriter(outputPath);
    inputLines.forEach((line, textIndex) => {
        const [filter, hexText] = line.split("\t");
        const text = fromHex(hexText);
        const { utf8Offsets, starts } = measure(text);
        patterns.forEach((pattern, patternIndex) => {
            if (filter !== "*" && filter !== pattern.entity) return;
            const search = pattern.search(text);
            const searchTokens = starts.map((cursor) => {
                const found = search(cursor);
                return found === undefined ? "-" : String(utf8Offsets[found]);
            });
            const anchoredTokens = starts.map((start) => {
                pattern.anchored.lastIndex = start;
                const groups = pattern.anchored.exec(text)?.indices?.groups;
                const found = groups?.secret ?? groups?.pii_candidate;
                return found
                    ? `${utf8Offsets[found[0]]}-${utf8Offsets[found[1]]}`
                    : "-";
            });
            const leftTokens = pattern.leftBoundary
                ? starts
                      .slice(1)
                      .map((end, index) =>
                          pattern.leftBoundary.test(
                              text.slice(starts[index], end),
                          )
                              ? "1"
                              : "0",
                      )
                : [];
            const isEmpty =
                searchTokens.every((token) => token === "-") &&
                anchoredTokens.every((token) => token === "-") &&
                leftTokens.every((token) => token === "0");
            if (!isEmpty)
                writer.write(
                    `${textIndex} ${patternIndex} S:${encodeRuns(searchTokens)} A:${encodeRuns(anchoredTokens)} L:${encodeRuns(leftTokens)}`,
                );
        });
    });
    writer.close();
    return { compileErrorCount: variant.compileErrorCount() };
}

/** Same lines as `redact-rust-differential core`: sorted "<rule id>:<start>-<end>" tokens. */
export function writeCoreResults(
    engine,
    { inputLines, outputPath, isNaive = false },
) {
    const variant = createVariant(engine, isNaive);
    const isSensitiveField = (name) =>
        engine.hasSensitiveSuffix(engine.normalizeFieldName(name));
    const writer = createLineWriter(outputPath);
    inputLines.forEach((line, textIndex) => {
        const [path, hexText] = line.split("\t");
        const text = fromHex(hexText);
        const { utf8Offsets } = measure(text);
        const found = [];
        for (const rule of variant.coreRules)
            for (const [start, end] of rule.match(text))
                found.push([rule.id, start, end]);
        for (const detection of engine.detectPrivateKeys(text))
            found.push([detection.ruleId, detection.start, detection.end]);
        for (const [start, end] of engine.detectAssignments(
            text,
            isSensitiveField,
            path === "none" ? undefined : path,
        ))
            found.push(["field.sensitive", start, end]);
        const tokens = found
            .map(([id, start, end]) => [
                id,
                utf8Offsets[start],
                utf8Offsets[end],
            ])
            .sort(
                (a, b) =>
                    a[1] - b[1] ||
                    a[2] - b[2] ||
                    (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
            )
            .map(([id, start, end]) => `${id}:${start}-${end}`);
        writer.write(`${textIndex} ${tokens.join(",")}`);
    });
    writer.close();
    return { compileErrorCount: variant.compileErrorCount() };
}
