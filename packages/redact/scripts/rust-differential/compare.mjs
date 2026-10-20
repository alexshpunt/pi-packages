// Compare the Rust and JavaScript result files and measure what the inputs exercised.
import { readFileSync } from "node:fs";

const EXAMPLES_PER_GROUP = 2;
const CORE_EXAMPLE_LIMIT = 20;

const readLines = (path) =>
    readFileSync(path, "utf8").split("\n").filter(Boolean);
const fromHex = (text) => Buffer.from(text, "hex").toString("utf8");
const inputText = (line) => fromHex(line.split("\t")[1]);
const expandRuns = (encoded) =>
    encoded === ""
        ? []
        : encoded.split(",").flatMap((part) => {
              const [token, count] = part.split("*");
              return Array(Number(count ?? 1)).fill(token);
          });
const pairKey = (line) => line.split(" ", 2).map(Number);

function createSummary() {
    const summary = { mismatchCount: 0, mismatchesByGroup: {}, examples: [] };
    return {
        summary,
        /** Count a mismatch; keep the example only when one is given. */
        record(group, example) {
            summary.mismatchesByGroup[group] =
                (summary.mismatchesByGroup[group] ?? 0) + 1;
            if (example) summary.examples.push(example);
        },
    };
}

/** PII results are sparse and ordered by (input, pattern) on both sides, so merge by key. */
export function comparePiiResults({
    rustPath,
    javascriptPath,
    inputLines,
    patternLines,
}) {
    const rust = readLines(rustPath);
    const javascript = readLines(javascriptPath);
    const { summary, record } = createSummary();
    const examplesPerGroup = new Map();
    const emptyParts = ["S:", "A:", "L:"];
    let rustIndex = 0;
    let javascriptIndex = 0;
    while (rustIndex < rust.length || javascriptIndex < javascript.length) {
        const [rustText, rustPattern] =
            rustIndex < rust.length
                ? pairKey(rust[rustIndex])
                : [Infinity, Infinity];
        const [javascriptText, javascriptPattern] =
            javascriptIndex < javascript.length
                ? pairKey(javascript[javascriptIndex])
                : [Infinity, Infinity];
        let rustParts = emptyParts;
        let javascriptParts = emptyParts;
        let textIndex;
        let patternIndex;
        if (rustText === javascriptText && rustPattern === javascriptPattern) {
            const isSame = rust[rustIndex] === javascript[javascriptIndex];
            [textIndex, patternIndex] = [rustText, rustPattern];
            rustParts = rust[rustIndex++].split(" ").slice(2);
            javascriptParts = javascript[javascriptIndex++].split(" ").slice(2);
            if (isSame) continue;
        } else if (
            rustText < javascriptText ||
            (rustText === javascriptText && rustPattern < javascriptPattern)
        ) {
            [textIndex, patternIndex] = [rustText, rustPattern];
            rustParts = rust[rustIndex++].split(" ").slice(2);
        } else {
            [textIndex, patternIndex] = [javascriptText, javascriptPattern];
            javascriptParts = javascript[javascriptIndex++].split(" ").slice(2);
        }
        summary.mismatchCount++;
        const [entity, , expressionHex] =
            patternLines[patternIndex].split("\t");
        ["search", "anchored", "leftBoundary"].forEach((label, position) => {
            const rustTokens = expandRuns(rustParts[position].slice(2));
            const javascriptTokens = expandRuns(
                javascriptParts[position].slice(2),
            );
            const filler = label === "leftBoundary" ? "0" : "-";
            const length = Math.max(rustTokens.length, javascriptTokens.length);
            let at = 0;
            while (
                at < length &&
                (rustTokens[at] ?? filler) === (javascriptTokens[at] ?? filler)
            )
                at++;
            if (at === length) return;
            const group = `${entity}#${patternIndex}:${label}`;
            const shown = examplesPerGroup.get(group) ?? 0;
            examplesPerGroup.set(group, shown + 1);
            record(
                group,
                shown < EXAMPLES_PER_GROUP
                    ? {
                          group,
                          pattern: fromHex(expressionHex),
                          text: inputText(inputLines[textIndex]),
                          codePointIndex: at,
                          rust: rustTokens[at] ?? filler,
                          javascript: javascriptTokens[at] ?? filler,
                      }
                    : undefined,
            );
        });
    }
    return summary;
}

/** Core results have one line per input with sorted detection tokens. */
export function compareCoreResults({ rustPath, javascriptPath, inputLines }) {
    const rust = readLines(rustPath);
    const javascript = readLines(javascriptPath);
    const { summary, record } = createSummary();
    if (rust.length !== javascript.length)
        throw new Error(
            `Core result line counts differ: ${rust.length} vs ${javascript.length}`,
        );
    const tokensOf = (line) =>
        new Set(line.split(" ")[1]?.split(",").filter(Boolean) ?? []);
    rust.forEach((rustLine, index) => {
        if (rustLine === javascript[index]) return;
        summary.mismatchCount++;
        const rustTokens = tokensOf(rustLine);
        const javascriptTokens = tokensOf(javascript[index]);
        const onlyRust = [...rustTokens].filter(
            (token) => !javascriptTokens.has(token),
        );
        const onlyJavaScript = [...javascriptTokens].filter(
            (token) => !rustTokens.has(token),
        );
        const [path, hexText] = inputLines[index].split("\t");
        const ruleIds = new Set(
            [...onlyRust, ...onlyJavaScript].map(
                (token) => token.split(":")[0],
            ),
        );
        for (const ruleId of ruleIds)
            record(
                ruleId,
                summary.examples.length < CORE_EXAMPLE_LIMIT
                    ? { path, text: fromHex(hexText), onlyRust, onlyJavaScript }
                    : undefined,
            );
    });
    return summary;
}

/** Patterns that matched at least once and rule ids that detected at least once, per Rust. */
export function measureCoverage({ piiRustPath, coreRustPath, patternLines }) {
    const matchedPatterns = new Set();
    for (const line of readLines(piiRustPath)) {
        const [, patternIndex, , anchored] = line.split(" ");
        if (
            anchored
                .slice(2)
                .split(",")
                .some((token) => !token.startsWith("-"))
        )
            matchedPatterns.add(Number(patternIndex));
    }
    const detectedRuleIds = new Set();
    for (const line of readLines(coreRustPath))
        for (const token of line.split(" ")[1]?.split(",") ?? [])
            if (token) detectedRuleIds.add(token.split(":")[0]);
    return {
        patternCount: patternLines.length,
        unmatchedPatterns: patternLines
            .map((line, index) =>
                matchedPatterns.has(index)
                    ? undefined
                    : `${line.split("\t")[0]}#${index}`,
            )
            .filter(Boolean),
        detectedRuleIds: [...detectedRuleIds].sort(),
    };
}
